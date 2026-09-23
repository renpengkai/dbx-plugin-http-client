package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// resetDirState clears the process-wide configured-directory state and points
// DBX_PLUGIN_DATA_DIR at a fresh temp dir, so tests never touch the real user
// config. It returns the plugin data dir.
func resetDirState(t *testing.T) string {
	t.Helper()
	dataDir := t.TempDir()
	t.Setenv("DBX_PLUGIN_DATA_DIR", dataDir)
	t.Setenv("DBX_PLUGIN_SPACE", "")
	dirMu.Lock()
	currentDir = ""
	dirMu.Unlock()
	return dataDir
}

// --------------------------------------------------------------- connDir ---

func TestConnDirFromValuesTopLevel(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "资料")
	got := connDirFromValues(map[string]any{"storage_dir": dir})
	if got != dir {
		t.Fatalf("top-level storage_dir = %q, want %q", got, dir)
	}
}

func TestConnDirFromValuesNestedConfig(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested")
	got := connDirFromValues(map[string]any{
		"connection": map[string]any{"id": "abc"},
		"config":     map[string]any{"storageDir": dir},
	})
	if got != dir {
		t.Fatalf("nested storageDir = %q, want %q", got, dir)
	}
}

func TestConnDirFromValuesConfigString(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "strcfg")
	got := connDirFromValues(map[string]any{
		"config": "storage_dir=" + dir + "&name=demo",
	})
	if got != dir {
		t.Fatalf("config-string storage_dir = %q, want %q", got, dir)
	}
}

func TestConnDirFromValuesPlainString(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "plain")
	got := connDirFromValues(map[string]any{"external_config": dir})
	if got != dir {
		t.Fatalf("plain string dir = %q, want %q", got, dir)
	}
}

func TestConnDirFromValuesEmpty(t *testing.T) {
	if got := connDirFromValues(map[string]any{"storage_dir": "   "}); got != "" {
		t.Fatalf("blank dir should be ignored, got %q", got)
	}
	if got := connDirFromValues(map[string]any{"unrelated": "x"}); got != "" {
		t.Fatalf("unrelated keys should yield empty, got %q", got)
	}
}

// ------------------------------------------------------------- absorbDir ---

func TestAbsorbParamsRecursive(t *testing.T) {
	resetDirState(t)
	target := filepath.Join(t.TempDir(), "deep")

	params, err := json.Marshal(map[string]any{
		"outer": map[string]any{
			"inner": []any{
				map[string]any{"nope": 1},
				map[string]any{"storage_path": target},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	absorbParams(params)
	if got := configuredDir(); got != target {
		t.Fatalf("recursive absorb set %q, want %q", got, target)
	}
}

func TestAbsorbParamsIgnoresBlank(t *testing.T) {
	resetDirState(t)
	absorbParams(json.RawMessage(`{"storage_dir":"   "}`))
	if got := configuredDir(); got != "" {
		t.Fatalf("blank should not configure a dir, got %q", got)
	}
}

// --------------------------------------------------------- persist + load --

func TestSetDirPersistsAndLoadsBack(t *testing.T) {
	dataDir := resetDirState(t)
	target := filepath.Join(t.TempDir(), "keep-me")

	setDir(target)
	if got := configuredDir(); got != target {
		t.Fatalf("configuredDir = %q, want %q", got, target)
	}
	// The pointer must live in <DBX_PLUGIN_DATA_DIR>/config.json.
	payload, err := os.ReadFile(filepath.Join(dataDir, "config.json"))
	if err != nil {
		t.Fatalf("config.json not written: %v", err)
	}
	var config map[string]any
	if err := json.Unmarshal(payload, &config); err != nil {
		t.Fatalf("config.json malformed: %v", err)
	}
	if config["storage_dir"] != target {
		t.Fatalf("config.json storage_dir = %v, want %q", config["storage_dir"], target)
	}

	// Simulate a sidecar restart: drop in-memory state, then reload from disk.
	dirMu.Lock()
	currentDir = ""
	dirMu.Unlock()
	loadConfig()
	if got := configuredDir(); got != target {
		t.Fatalf("after reload configuredDir = %q, want %q", got, target)
	}
}

func TestStoreDirFallsBackToDefault(t *testing.T) {
	resetDirState(t)
	got := storeDir()
	if got == "" {
		t.Fatal("storeDir should never be empty")
	}
	if dirConfigured() {
		t.Fatalf("dirConfigured should be false by default, got dir %q", got)
	}
	if filepath.Base(storeFilePath()) != "store.json" {
		t.Fatalf("storeFilePath should end in store.json, got %q", storeFilePath())
	}
}

// ------------------------------------------------------------ set dir RPC --

func TestHandleStoreSetDirRejectsEmpty(t *testing.T) {
	resetDirState(t)
	p := &plugin{store: newStoreManager()}
	if _, pluginErr := p.handleStoreSetDir(json.RawMessage(`{"dir":"   "}`)); pluginErr == nil {
		t.Fatal("empty dir should be rejected")
	}
}

func TestHandleStoreSetDirCreatesAndConfigures(t *testing.T) {
	resetDirState(t)
	target := filepath.Join(t.TempDir(), "created")
	p := &plugin{store: newStoreManager()}

	result, pluginErr := p.handleStoreSetDir(json.RawMessage(`{"dir":` + mustJSON(target) + `}`))
	if pluginErr != nil {
		t.Fatalf("setDir: %s", pluginErr.Message)
	}
	info, ok := result.(map[string]any)
	if !ok || info["configured"] != true {
		t.Fatalf("unexpected result %#v", result)
	}
	if stat, err := os.Stat(target); err != nil || !stat.IsDir() {
		t.Fatalf("target dir was not created: %v", err)
	}
	if got := storeFilePath(); got != filepath.Join(target, "store.json") {
		t.Fatalf("storeFilePath = %q, want under %q", got, target)
	}
}

func TestEnsureDirRejectsUnwritable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission semantics differ on windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission bits")
	}
	parent := t.TempDir()
	if err := os.Chmod(parent, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(parent, 0o700)
	if err := ensureDir(filepath.Join(parent, "child")); err == nil {
		t.Fatal("expected a writability error")
	}
}

// ------------------------------------------------------- store save/load --

func TestStoreSaveThenLoadInConfiguredDir(t *testing.T) {
	resetDirState(t)
	target := t.TempDir()
	p := &plugin{store: newStoreManager()}

	document := `{"collections":[{"name":"demo"}],"environments":[]}`
	saveParams := `{"store":` + document + `,"storage_dir":` + mustJSON(target) + `}`
	saveResult, pluginErr := p.handleStoreSave(json.RawMessage(saveParams))
	if pluginErr != nil {
		t.Fatalf("save: %s", pluginErr.Message)
	}
	saved, _ := saveResult.(map[string]any)
	if saved["configured"] != true || saved["dir"] != target {
		t.Fatalf("save result = %#v", saveResult)
	}
	if _, err := os.Stat(filepath.Join(target, "store.json")); err != nil {
		t.Fatalf("store.json not written to configured dir: %v", err)
	}

	loadResult, pluginErr := p.handleStoreLoad()
	if pluginErr != nil {
		t.Fatalf("load: %s", pluginErr.Message)
	}
	loaded, _ := loadResult.(map[string]any)
	if loaded["exists"] != true {
		t.Fatalf("expected exists=true, got %#v", loaded)
	}
	if loaded["dir"] != target {
		t.Fatalf("load dir = %v, want %q", loaded["dir"], target)
	}
	var roundTrip map[string]any
	if err := json.Unmarshal(loaded["store"].(json.RawMessage), &roundTrip); err != nil {
		t.Fatalf("store payload not valid JSON: %v", err)
	}
	if _, ok := roundTrip["collections"]; !ok {
		t.Fatalf("collections missing after round-trip: %#v", roundTrip)
	}
}

func TestStoreLoadMissingReturnsNotExists(t *testing.T) {
	resetDirState(t)
	p := &plugin{store: newStoreManager()}
	result, pluginErr := p.handleStoreLoad()
	if pluginErr != nil {
		t.Fatalf("load: %s", pluginErr.Message)
	}
	info := result.(map[string]any)
	if info["exists"] != false {
		t.Fatalf("expected exists=false for a fresh dir, got %#v", info)
	}
}

func TestStoreLoadCorruptedIsFlagged(t *testing.T) {
	resetDirState(t)
	target := t.TempDir()
	setDir(target)
	if err := os.WriteFile(filepath.Join(target, "store.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := &plugin{store: newStoreManager()}
	result, pluginErr := p.handleStoreLoad()
	if pluginErr != nil {
		t.Fatalf("load: %s", pluginErr.Message)
	}
	info := result.(map[string]any)
	if info["corrupted"] != true {
		t.Fatalf("expected corrupted=true, got %#v", info)
	}
}

func TestStoreSaveRejectsOversizedPayload(t *testing.T) {
	resetDirState(t)
	p := &plugin{store: newStoreManager()}
	big := make([]byte, maxStoreBytes+1)
	for i := range big {
		big[i] = 'x'
	}
	params, _ := json.Marshal(map[string]any{"store": json.RawMessage(`"` + string(big) + `"`)})
	if _, pluginErr := p.handleStoreSave(params); pluginErr == nil {
		t.Fatal("oversized payload should be rejected")
	}
}

// ------------------------------------------------------- connection RPC --

func TestConnectionConnectAbsorbsDir(t *testing.T) {
	resetDirState(t)
	target := filepath.Join(t.TempDir(), "conn")
	p := &plugin{store: newStoreManager()}

	params, _ := json.Marshal(map[string]any{"storage_dir": target, "connectionId": "c1"})
	result, pluginErr := p.handleConnectionConnect(params)
	if pluginErr != nil {
		t.Fatalf("connect: %s", pluginErr.Message)
	}
	info := result.(map[string]any)
	if info["configured"] != true || info["dir"] != target {
		t.Fatalf("connect result = %#v", result)
	}
	p.connectionMu.Lock()
	_, tracked := p.connections["c1"]
	p.connectionMu.Unlock()
	if !tracked {
		t.Fatal("connection id should be tracked")
	}

	if _, pluginErr := p.handleConnectionDisconnect(json.RawMessage(`{"connectionId":"c1"}`)); pluginErr != nil {
		t.Fatalf("disconnect: %s", pluginErr.Message)
	}
	p.connectionMu.Lock()
	_, stillThere := p.connections["c1"]
	p.connectionMu.Unlock()
	if stillThere {
		t.Fatal("connection id should be dropped on disconnect")
	}
}

func TestConnectionTestReportsDir(t *testing.T) {
	resetDirState(t)
	p := &plugin{store: newStoreManager()}
	result, pluginErr := p.handleConnectionTest()
	if pluginErr != nil {
		t.Fatalf("test: %s", pluginErr.Message)
	}
	info := result.(map[string]any)
	if info["success"] != true {
		t.Fatalf("expected success, got %#v", info)
	}
	if info["dir"] != storeDir() {
		t.Fatalf("test dir = %v, want %q", info["dir"], storeDir())
	}
}

// --------------------------------------------------------------- helper ----

func mustJSON(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}