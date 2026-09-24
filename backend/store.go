package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// maxStoreBytes bounds the persisted workbench state (collections, environments,
// history). Environments may hold API tokens, so the file is written 0600.
const maxStoreBytes = 4 << 20

/* ------------------------------------------------------------ data dir ----
   The workbench state used to live hard-coded under os.UserConfigDir, which a
   Docker container throws away on every rebuild. The user can now point the
   plugin at any directory (chosen in the connection form or from Settings); the
   choice is persisted in <DBX_PLUGIN_DATA_DIR>/config.json so it survives
   restarts. When no directory is configured we fall back to the host-provided
   per-plugin data directory, then to the legacy config path. */

var dirMu sync.Mutex
var currentDir string

var dirKeys = map[string]bool{
	"storage_dir":  true,
	"storageDir":   true,
	"storage_path": true,
	"storagePath":  true,
	"data_dir":     true,
	"dataDir":      true,
}

// pluginDataDir is where the sidecar keeps its own bookkeeping (config.json,
// diagnostics). The host injects DBX_PLUGIN_DATA_DIR; it survives upgrades and
// uninstalls, so it is the right place for the configured-directory pointer.
func pluginDataDir() string {
	if dir := strings.TrimSpace(os.Getenv("DBX_PLUGIN_DATA_DIR")); dir != "" {
		return dir
	}
	if dir := strings.TrimSpace(os.Getenv("DBX_PLUGIN_SPACE")); dir != "" {
		return dir
	}
	if base, err := os.UserConfigDir(); err == nil && base != "" {
		return filepath.Join(base, "dbx", "plugins", pluginID)
	}
	return filepath.Join(".", "data")
}

// defaultStoreDir is the legacy location, kept for users who never configure a
// directory so their existing collections keep loading.
func defaultStoreDir() string {
	if base, err := os.UserConfigDir(); err == nil && base != "" {
		return filepath.Join(base, "dbx-http-client")
	}
	return filepath.Join(pluginDataDir(), "store")
}

func loadConfig() {
	payload, err := os.ReadFile(filepath.Join(pluginDataDir(), "config.json"))
	if err != nil {
		return
	}
	var config map[string]any
	if json.Unmarshal(payload, &config) != nil {
		return
	}
	if value, ok := config["storage_dir"].(string); ok && strings.TrimSpace(value) != "" {
		currentDir = strings.TrimSpace(value)
	}
}

func setDir(dir string) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return
	}
	dirMu.Lock()
	same := currentDir == dir
	currentDir = dir
	dirMu.Unlock()
	if same {
		return
	}
	if err := os.MkdirAll(pluginDataDir(), 0o700); err == nil {
		if payload, err := json.Marshal(map[string]any{"storage_dir": dir}); err == nil {
			_ = os.WriteFile(filepath.Join(pluginDataDir(), "config.json"), payload, 0o600)
		}
	}
}

func absorbDir(value any) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if dirKeys[key] {
				if text, ok := child.(string); ok && strings.TrimSpace(text) != "" {
					setDir(text)
				}
			}
		}
		for _, child := range typed {
			absorbDir(child)
		}
	case []any:
		for _, item := range typed {
			absorbDir(item)
		}
	}
}

func absorbParams(params json.RawMessage) {
	if len(params) == 0 {
		return
	}
	var value any
	if json.Unmarshal(params, &value) != nil {
		return
	}
	absorbDir(value)
}

// connDirFromValues digs storage_dir out of a connection/connect payload,
// covering the nested shapes the host may use (config / external_config /
// connection, or config passed as a query-ish string).
func connDirFromValues(values map[string]any) string {
	candidates := []any{
		values["storage_dir"], values["storageDir"],
		values["config"], values["external_config"], values["connection"],
	}
	for _, candidate := range candidates {
		if candidate == nil {
			continue
		}
		switch typed := candidate.(type) {
		case string:
			text := strings.TrimSpace(typed)
			// A bare value is the directory itself. Only reject strings that
			// look like a query string ("k=v&...") or a serialized object —
			// note that a Windows drive letter ("C:\\data") legitimately
			// contains a colon, so colon must NOT be treated as a separator.
			if text != "" && !strings.ContainsAny(text, "={") {
				return text
			}
			if index := strings.Index(text, "storage_dir="); index >= 0 {
				rest := text[index+len("storage_dir="):]
				if end := strings.IndexAny(rest, "&\""); end >= 0 {
					rest = rest[:end]
				}
				if value := strings.TrimSpace(rest); value != "" {
					return value
				}
			}
		case map[string]any:
			for _, key := range []string{"storage_dir", "storageDir", "storage_path", "storagePath", "data_dir", "dataDir"} {
				if value, ok := typed[key].(string); ok && strings.TrimSpace(value) != "" {
					return strings.TrimSpace(value)
				}
			}
		}
	}
	return ""
}

func configuredDir() string {
	dirMu.Lock()
	defer dirMu.Unlock()
	return currentDir
}

// dirConfigured reports whether the user pointed the plugin at their own
// directory rather than the implicit default.
func dirConfigured() bool {
	return configuredDir() != ""
}

// storeDir is the directory the store.json file lives in.
func storeDir() string {
	if dir := configuredDir(); dir != "" {
		return dir
	}
	return defaultStoreDir()
}

func storeFilePath() string { return filepath.Join(storeDir(), "store.json") }

/* ------------------------------------------------------------- manager ---- */

type storeManager struct {
	mutex sync.Mutex
}

func newStoreManager() *storeManager {
	return &storeManager{}
}

func (s *storeManager) filePath() (string, error) {
	return storeFilePath(), nil
}

// ensureDir creates the configured store directory (0700) and verifies it is
// writable, so a bad path surfaces as an actionable error at connect time
// rather than a silent failure on the next save.
func ensureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	probe := filepath.Join(dir, ".write-probe")
	if err := os.WriteFile(probe, []byte(time.Now().Format(time.RFC3339)), 0o600); err != nil {
		return err
	}
	_ = os.Remove(probe)
	return nil
}

func (p *plugin) handleStoreLoad() (any, *dbxpluginsdk.PluginError) {
	path, _ := p.store.filePath()
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{
				"path": path, "dir": storeDir(), "configured": dirConfigured(),
				"store": nil, "exists": false,
			}, nil
		}
		return nil, dbxpluginsdk.NewError(-32000, "Failed to read configuration: "+err.Error())
	}
	var document json.RawMessage = payload
	if !json.Valid(payload) {
		return map[string]any{
			"path": path, "dir": storeDir(), "configured": dirConfigured(),
			"store": nil, "exists": true, "corrupted": true,
		}, nil
	}
	return map[string]any{
		"path": path, "dir": storeDir(), "configured": dirConfigured(),
		"store": document, "exists": true,
	}, nil
}

func (p *plugin) handleStoreSave(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var payload struct {
		Store json.RawMessage `json:"store"`
		Dir   string          `json:"storage_dir"`
	}
	if pluginErr := decodeParams(params, &payload); pluginErr != nil {
		return nil, pluginErr
	}
	if len(payload.Store) == 0 {
		return nil, dbxpluginsdk.NewError(-32602, "Missing store content")
	}
	if len(payload.Store) > maxStoreBytes {
		return nil, dbxpluginsdk.NewError(-32602, fmt.Sprintf("Workbench data exceeds %s; please clear the history", humanBytes(maxStoreBytes)))
	}
	if dir := strings.TrimSpace(payload.Dir); dir != "" {
		setDir(dir)
	}
	path, _ := p.store.filePath()

	p.store.mutex.Lock()
	defer p.store.mutex.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "Failed to create configuration directory: "+err.Error())
	}
	temporary := fmt.Sprintf("%s.%d.tmp", path, time.Now().UnixNano())
	if err := os.WriteFile(temporary, payload.Store, 0o600); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "Failed to write temporary file: "+err.Error())
	}
	if err := os.Rename(temporary, path); err != nil {
		// A few sandboxes and network filesystems refuse to replace an existing
		// file; fall back to a direct write so settings still persist.
		if writeErr := os.WriteFile(path, payload.Store, 0o600); writeErr != nil {
			_ = os.Remove(temporary)
			return nil, dbxpluginsdk.NewError(-32000, "Failed to replace configuration file: "+err.Error())
		}
		_ = os.Remove(temporary)
	}
	return map[string]any{
		"path": path, "dir": storeDir(), "configured": dirConfigured(),
		"bytes": len(payload.Store), "savedAt": time.Now().Format(time.RFC3339),
	}, nil
}

// handleStoreSetDir points the store at a new directory and probes writability.
func (p *plugin) handleStoreSetDir(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var payload struct {
		Dir        string `json:"dir"`
		StorageDir string `json:"storage_dir"`
	}
	if pluginErr := decodeParams(params, &payload); pluginErr != nil {
		return nil, pluginErr
	}
	dir := strings.TrimSpace(payload.Dir)
	if dir == "" {
		dir = strings.TrimSpace(payload.StorageDir)
	}
	if dir == "" {
		return nil, dbxpluginsdk.NewError(-32602, "Storage directory cannot be empty")
	}
	if err := ensureDir(dir); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "Cannot write to this directory: "+err.Error())
	}
	setDir(dir)
	return map[string]any{"dir": storeDir(), "path": storeFilePath(), "configured": true}, nil
}

/* --------------------------------------------------- connection lifecycle --
   The plugin contributes a connection-provider so the storage directory can be
   chosen in the same native folder picker DBX uses everywhere else. These
   handlers keep the standard connection contract; the directory itself is
   absorbed from the connect payload. */

func (p *plugin) handleConnectionTest() (any, *dbxpluginsdk.PluginError) {
	dir := storeDir()
	if err := ensureDir(dir); err != nil {
		return map[string]any{"success": false, "message": "Cannot write to storage directory: " + err.Error()}, nil
	}
	return map[string]any{
		"success": true,
		"message": "HTTP Client is ready. Collections, environments and history will be saved to store.json in this directory.",
		"dir":     dir,
	}, nil
}

func (p *plugin) handleConnectionConnect(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var values map[string]any
	if len(params) > 0 {
		if err := json.Unmarshal(params, &values); err != nil {
			return nil, dbxpluginsdk.NewError(-32602, "Invalid connection parameters: "+err.Error())
		}
	}
	absorbParams(params)
	if dir := connDirFromValues(values); dir != "" {
		if err := ensureDir(dir); err != nil {
			return nil, dbxpluginsdk.NewError(-32000, "Cannot write to storage directory: "+err.Error())
		}
		setDir(dir)
	} else if err := ensureDir(storeDir()); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "Cannot write to storage directory: "+err.Error())
	}
	connectionID := ""
	if value, ok := values["connectionId"].(string); ok {
		connectionID = value
	}
	if connectionID == "" {
		if connection, ok := values["connection"].(map[string]any); ok {
			if value, ok := connection["id"].(string); ok {
				connectionID = value
			}
		}
	}
	p.trackConnection(connectionID)
	return map[string]any{
		"success":    true,
		"connectionId": connectionID,
		"dir":        storeDir(),
		"path":       storeFilePath(),
		"configured": dirConfigured(),
	}, nil
}

func (p *plugin) handleConnectionDisconnect(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var values map[string]any
	if len(params) > 0 {
		_ = json.Unmarshal(params, &values)
	}
	connectionID := ""
	if value, ok := values["connectionId"].(string); ok {
		connectionID = value
	}
	p.dropConnection(connectionID)
	return map[string]any{"success": true}, nil
}