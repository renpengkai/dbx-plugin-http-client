package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// maxStoreBytes bounds the persisted workbench state (collections, environments,
// history). Environments may hold API tokens, so the file is written 0600.
const maxStoreBytes = 4 << 20

type storeManager struct {
	mutex sync.Mutex
}

func newStoreManager() *storeManager {
	return &storeManager{}
}

func (s *storeManager) filePath() (string, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "dbx-http-client", "store.json"), nil
}

func (p *plugin) handleStoreLoad() (any, *dbxpluginsdk.PluginError) {
	path, err := p.store.filePath()
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "无法定位配置目录："+err.Error())
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{"path": path, "store": nil, "exists": false}, nil
		}
		return nil, dbxpluginsdk.NewError(-32000, "读取配置失败："+err.Error())
	}
	var document json.RawMessage = payload
	if !json.Valid(payload) {
		return map[string]any{"path": path, "store": nil, "exists": true, "corrupted": true}, nil
	}
	return map[string]any{"path": path, "store": document, "exists": true}, nil
}

func (p *plugin) handleStoreSave(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var payload struct {
		Store json.RawMessage `json:"store"`
	}
	if pluginErr := decodeParams(params, &payload); pluginErr != nil {
		return nil, pluginErr
	}
	if len(payload.Store) == 0 {
		return nil, dbxpluginsdk.NewError(-32602, "缺少 store 内容")
	}
	if len(payload.Store) > maxStoreBytes {
		return nil, dbxpluginsdk.NewError(-32602, fmt.Sprintf("工作台数据超过 %s，请清理历史记录", humanBytes(maxStoreBytes)))
	}
	path, err := p.store.filePath()
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "无法定位配置目录："+err.Error())
	}

	p.store.mutex.Lock()
	defer p.store.mutex.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "创建配置目录失败："+err.Error())
	}
	temporary := fmt.Sprintf("%s.%d.tmp", path, time.Now().UnixNano())
	if err := os.WriteFile(temporary, payload.Store, 0o600); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "写入临时文件失败："+err.Error())
	}
	if err := os.Rename(temporary, path); err != nil {
		// A few sandboxes and network filesystems refuse to replace an existing
		// file; fall back to a direct write so settings still persist.
		if writeErr := os.WriteFile(path, payload.Store, 0o600); writeErr != nil {
			_ = os.Remove(temporary)
			return nil, dbxpluginsdk.NewError(-32000, "替换配置文件失败："+err.Error())
		}
		_ = os.Remove(temporary)
	}
	return map[string]any{"path": path, "bytes": len(payload.Store), "savedAt": time.Now().Format(time.RFC3339)}, nil
}
