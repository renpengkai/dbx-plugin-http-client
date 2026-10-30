package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

const (
	maxWebDAVBodyBytes = 4 << 20
	webDAVTimeout      = 45 * time.Second
)

type webDAVConfig struct {
	Endpoint   string `json:"endpoint"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	RemotePath string `json:"remotePath"`
	UserAgent  string `json:"userAgent"`
}

func (c webDAVConfig) normalized() (webDAVConfig, error) {
	endpoint := strings.TrimSpace(c.Endpoint)
	if endpoint == "" {
		return c, fmt.Errorf("缺少 WebDAV endpoint")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return c, fmt.Errorf("WebDAV endpoint 无效，需为 http(s)://host[/path]")
	}
	remote := strings.TrimSpace(c.RemotePath)
	if remote == "" {
		remote = "DBX/http-client/store.json"
	}
	remote = strings.TrimPrefix(remote, "/")
	c.Endpoint = strings.TrimRight(endpoint, "/")
	c.RemotePath = remote
	c.Username = strings.TrimSpace(c.Username)
	c.UserAgent = strings.TrimSpace(c.UserAgent)
	return c, nil
}

func (c webDAVConfig) targetURL() (string, error) {
	base, err := url.Parse(c.Endpoint + "/")
	if err != nil {
		return "", err
	}
	joined, err := url.Parse(c.RemotePath)
	if err != nil {
		return "", err
	}
	return base.ResolveReference(joined).String(), nil
}

func (c webDAVConfig) client() *http.Client {
	return &http.Client{Timeout: webDAVTimeout}
}

func (c webDAVConfig) applyAuth(req *http.Request) {
	if c.Username != "" || c.Password != "" {
		req.SetBasicAuth(c.Username, c.Password)
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
}

func (p *plugin) handleWebDAVTest(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var cfg webDAVConfig
	if err := decodeParams(params, &cfg); err != nil {
		return nil, err
	}
	normalized, normErr := cfg.normalized()
	if normErr != nil {
		return nil, dbxpluginsdk.NewError(-32602, normErr.Error())
	}
	target, err := normalized.targetURL()
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "远程路径无效："+err.Error())
	}
	req, err := http.NewRequest(http.MethodHead, target, nil)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, err.Error())
	}
	normalized.applyAuth(req)
	resp, err := normalized.client().Do(req)
	if err != nil {
		// Some servers reject HEAD; fall back to PROPFIND-ish GET with Range.
		getReq, getErr := http.NewRequest(http.MethodGet, target, nil)
		if getErr != nil {
			return nil, dbxpluginsdk.NewError(-32000, "WebDAV 连接失败："+err.Error())
		}
		normalized.applyAuth(getReq)
		getReq.Header.Set("Range", "bytes=0-0")
		resp, err = normalized.client().Do(getReq)
		if err != nil {
			return nil, dbxpluginsdk.NewError(-32000, "WebDAV 连接失败："+err.Error())
		}
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	ok := resp.StatusCode >= 200 && resp.StatusCode < 400 || resp.StatusCode == http.StatusNotFound
	if !ok {
		return nil, dbxpluginsdk.NewError(-32000, fmt.Sprintf("WebDAV 探测失败：HTTP %d", resp.StatusCode))
	}
	return map[string]any{
		"ok":         true,
		"status":     resp.StatusCode,
		"remoteUrl":  target,
		"remotePath": normalized.RemotePath,
	}, nil
}

func (p *plugin) handleWebDAVUpload(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var payload struct {
		webDAVConfig
		Store json.RawMessage `json:"store"`
	}
	if err := decodeParams(params, &payload); err != nil {
		return nil, err
	}
	if len(payload.Store) == 0 {
		return nil, dbxpluginsdk.NewError(-32602, "缺少 store 内容")
	}
	if len(payload.Store) > maxWebDAVBodyBytes {
		return nil, dbxpluginsdk.NewError(-32602, fmt.Sprintf("同步数据超过 %s", humanBytes(maxWebDAVBodyBytes)))
	}
	normalized, normErr := payload.webDAVConfig.normalized()
	if normErr != nil {
		return nil, dbxpluginsdk.NewError(-32602, normErr.Error())
	}
	if mkErr := ensureWebDAVParents(normalized); mkErr != nil {
		return nil, dbxpluginsdk.NewError(-32000, "创建远端目录失败："+mkErr.Error())
	}
	target, err := normalized.targetURL()
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, err.Error())
	}
	req, err := http.NewRequest(http.MethodPut, target, bytes.NewReader(payload.Store))
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, err.Error())
	}
	normalized.applyAuth(req)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.ContentLength = int64(len(payload.Store))
	resp, err := normalized.client().Do(req)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "WebDAV 上传失败："+err.Error())
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, dbxpluginsdk.NewError(-32000, fmt.Sprintf("WebDAV 上传失败：HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(body))))
	}
	return map[string]any{
		"ok":         true,
		"status":     resp.StatusCode,
		"bytes":      len(payload.Store),
		"remoteUrl":  target,
		"remotePath": normalized.RemotePath,
		"uploadedAt": time.Now().Format(time.RFC3339),
	}, nil
}

func (p *plugin) handleWebDAVDownload(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var cfg webDAVConfig
	if err := decodeParams(params, &cfg); err != nil {
		return nil, err
	}
	normalized, normErr := cfg.normalized()
	if normErr != nil {
		return nil, dbxpluginsdk.NewError(-32602, normErr.Error())
	}
	target, err := normalized.targetURL()
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, err.Error())
	}
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, err.Error())
	}
	normalized.applyAuth(req)
	resp, err := normalized.client().Do(req)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "WebDAV 下载失败："+err.Error())
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxWebDAVBodyBytes+1))
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "读取远端快照失败："+err.Error())
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, dbxpluginsdk.NewError(-32000, "远端快照不存在")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, dbxpluginsdk.NewError(-32000, fmt.Sprintf("WebDAV 下载失败：HTTP %d", resp.StatusCode))
	}
	if len(payload) > maxWebDAVBodyBytes {
		return nil, dbxpluginsdk.NewError(-32000, fmt.Sprintf("远端快照超过 %s", humanBytes(maxWebDAVBodyBytes)))
	}
	if !json.Valid(payload) {
		return nil, dbxpluginsdk.NewError(-32000, "远端内容不是合法 JSON 快照")
	}
	return map[string]any{
		"ok":         true,
		"status":     resp.StatusCode,
		"bytes":      len(payload),
		"remoteUrl":  target,
		"remotePath": normalized.RemotePath,
		"store":      json.RawMessage(payload),
		"downloadedAt": time.Now().Format(time.RFC3339),
	}, nil
}

func ensureWebDAVParents(cfg webDAVConfig) error {
	parts := strings.Split(cfg.RemotePath, "/")
	if len(parts) <= 1 {
		return nil
	}
	client := cfg.client()
	current := ""
	for _, part := range parts[:len(parts)-1] {
		if part == "" || part == "." {
			continue
		}
		if current == "" {
			current = part
		} else {
			current = path.Join(current, part)
		}
		targetBase, err := url.Parse(cfg.Endpoint + "/")
		if err != nil {
			return err
		}
		rel, err := url.Parse(current)
		if err != nil {
			return err
		}
		dirURL := targetBase.ResolveReference(rel).String()
		if !strings.HasSuffix(dirURL, "/") {
			dirURL += "/"
		}
		req, err := http.NewRequest("MKCOL", dirURL, nil)
		if err != nil {
			return err
		}
		cfg.applyAuth(req)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		resp.Body.Close()
		// 201 created, 405/409 already exists — all acceptable.
		if resp.StatusCode >= 500 {
			return fmt.Errorf("MKCOL %s → HTTP %d", dirURL, resp.StatusCode)
		}
	}
	return nil
}
