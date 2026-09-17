package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

const (
	maxChunkBytes       = 512 << 10
	bodyTTL             = 30 * time.Minute
	maxStoredBodies     = 8
	maxStoredBodyBytes  = 96 << 20
	progressGranularity = 256 << 10
)

type headerOut struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type redirectOut struct {
	Status   int    `json:"status"`
	Location string `json:"location"`
}

type sendResult struct {
	RequestID          string            `json:"requestId"`
	OK                 bool              `json:"ok"`
	Error              *requestError     `json:"error,omitempty"`
	Method             string            `json:"method"`
	URL                string            `json:"url"`
	FinalURL           string            `json:"finalUrl"`
	Status             int               `json:"status"`
	StatusText         string            `json:"statusText"`
	HTTPVersion        string            `json:"httpVersion"`
	DurationMs         int64             `json:"durationMs"`
	FirstByteMs        int64             `json:"firstByteMs"`
	SizeBytes          int64             `json:"sizeBytes"`
	ContentType        string            `json:"contentType"`
	Headers            []headerOut       `json:"headers"`
	SetCookies         []string          `json:"setCookies"`
	Redirects          []redirectOut     `json:"redirects"`
	RequestHeaders     []headerOut       `json:"requestHeaders"`
	RequestBodyPreview string            `json:"requestBodyPreview"`
	BodyID             string            `json:"bodyId"`
	BodyPreviewBase64  string            `json:"bodyPreviewBase64"`
	BodyPreviewBytes   int               `json:"bodyPreviewBytes"`
	BodyTruncated      bool              `json:"bodyTruncated"`
	BodyReadError      string            `json:"bodyReadError,omitempty"`
	SavedPath          string            `json:"savedPath,omitempty"`
	Notice             string            `json:"notice,omitempty"`
	Metadata           map[string]string `json:"metadata,omitempty"`
}

type storedBody struct {
	payload     []byte
	contentType string
	createdAt   time.Time
}

type bodyStore struct {
	mu      sync.Mutex
	entries map[string]*storedBody
	order   []string
	bytes   int64
	counter uint64
}

func newBodyStore() *bodyStore {
	return &bodyStore{entries: map[string]*storedBody{}}
}

func (s *bodyStore) put(payload []byte, contentType string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	id := fmt.Sprintf("body-%d-%d", time.Now().UnixMilli(), atomic.AddUint64(&s.counter, 1))
	s.entries[id] = &storedBody{payload: payload, contentType: contentType, createdAt: time.Now()}
	s.order = append(s.order, id)
	s.bytes += int64(len(payload))
	for len(s.order) > maxStoredBodies || s.bytes > maxStoredBodyBytes {
		if len(s.order) <= 1 {
			break
		}
		oldest := s.order[0]
		s.order = s.order[1:]
		if entry, ok := s.entries[oldest]; ok {
			s.bytes -= int64(len(entry.payload))
			delete(s.entries, oldest)
		}
	}
	return id
}

func (s *bodyStore) get(id string) (*storedBody, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[id]
	return entry, ok
}

func (s *bodyStore) pruneLocked() {
	cutoff := time.Now().Add(-bodyTTL)
	kept := s.order[:0]
	for _, id := range s.order {
		entry, ok := s.entries[id]
		if ok && entry.createdAt.Before(cutoff) {
			s.bytes -= int64(len(entry.payload))
			delete(s.entries, id)
			continue
		}
		kept = append(kept, id)
	}
	s.order = kept
}

type transportKey struct {
	verifyTLS bool
	proxy     string
}

type executor struct {
	mu          sync.Mutex
	inflight    map[string]context.CancelFunc
	transportMu sync.Mutex
	transports  map[transportKey]*http.Transport
	bodies      *bodyStore
}

func newExecutor() *executor {
	return &executor{
		inflight:   map[string]context.CancelFunc{},
		transports: map[transportKey]*http.Transport{},
		bodies:     newBodyStore(),
	}
}

func (e *executor) register(id string, cancel context.CancelFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.inflight[id] = cancel
}

func (e *executor) unregister(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.inflight, id)
}

func (e *executor) cancel(id string) bool {
	e.mu.Lock()
	cancel, ok := e.inflight[id]
	e.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

func msSince(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}

// describeSentRequest reports what actually leaves the process. net/http fills in
// User-Agent and Accept-Encoding at write time instead of mutating Header, so the
// implied defaults are listed explicitly and marked in the UI.
func describeSentRequest(request *http.Request) []headerOut {
	explicit := flatten(request.Header)
	has := func(name string) bool {
		for _, header := range explicit {
			if strings.EqualFold(header.Key, name) {
				return true
			}
		}
		return false
	}
	out := []headerOut{{Key: "Host", Value: request.URL.Host}}
	if !has("User-Agent") {
		out = append(out, headerOut{Key: "User-Agent", Value: "Go-http-client/1.1"})
	}
	if !has("Accept-Encoding") {
		out = append(out, headerOut{Key: "Accept-Encoding", Value: "gzip (由客户端自动添加)"})
	}
	if request.ContentLength > 0 {
		out = append(out, headerOut{Key: "Content-Length", Value: fmt.Sprintf("%d", request.ContentLength)})
	}
	out = append(out, explicit...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func flatten(headers http.Header) []headerOut {
	out := make([]headerOut, 0, len(headers))
	for key, values := range headers {
		for _, value := range values {
			out = append(out, headerOut{Key: key, Value: value})
		}
	}
	return out
}

func (e *executor) execute(spec *sendRequest, emitter *dbxpluginsdk.Emitter) *sendResult {
	started := time.Now()
	result := &sendResult{
		RequestID: spec.RequestID,
		Method:    spec.Method,
		URL:       spec.URL,
		OK:        false,
	}
	request, requestErr := buildRequest(spec)
	if requestErr != nil {
		result.Error = requestErr
		result.DurationMs = msSince(started)
		return result
	}
	result.RequestHeaders = describeSentRequest(request)
	switch spec.Body.Mode {
	case "raw", "urlencoded":
		if request.GetBody != nil {
			if clone, err := request.GetBody(); err == nil {
				result.RequestBodyPreview = describeBody(clone, request.ContentLength)
			}
		}
	case "formdata":
		result.RequestBodyPreview = fmt.Sprintf("(multipart/form-data，共 %d 个字段)", len(spec.Body.Fields))
	}

	ctx, cancel := context.WithTimeout(context.Background(), deadlineFrom(spec.Options.TimeoutMs))
	defer cancel()
	e.register(spec.RequestID, cancel)
	defer e.unregister(spec.RequestID)

	transport, transportErr := e.transportFor(spec)
	if transportErr != nil {
		result.Error = transportErr
		result.DurationMs = msSince(started)
		return result
	}
	redirects := []redirectOut{}
	follow := boolOr(spec.Options.FollowRedirect, true)
	client := &http.Client{Transport: transport}
	if !follow {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	} else {
		client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
			if scheme := strings.ToLower(next.URL.Scheme); scheme != "http" && scheme != "https" {
				return fmt.Errorf("拒绝跳转到非 HTTP(S) 地址：%s", next.URL.String())
			}
			if len(via) > spec.Options.MaxRedirects {
				return fmt.Errorf("超过最大跳转次数 %d", spec.Options.MaxRedirects)
			}
			status := 0
			if next.Response != nil {
				status = next.Response.StatusCode
			}
			redirects = append(redirects, redirectOut{Status: status, Location: next.URL.String()})
			return nil
		}
	}

	emitter.Event("http/progress", map[string]any{"requestId": spec.RequestID, "phase": "sending"})

	response, err := client.Do(request.WithContext(ctx))
	result.FirstByteMs = msSince(started)
	emitter.Event("http/progress", map[string]any{"requestId": spec.RequestID, "phase": "receiving"})
	if err != nil {
		result.Error = classifyError(err)
		result.DurationMs = msSince(started)
		result.Redirects = redirects
		return result
	}
	defer func() { _ = response.Body.Close() }()

	result.OK = true
	result.Status = response.StatusCode
	result.StatusText = statusText(response)
	result.HTTPVersion = httpVersion(response)
	result.ContentType = response.Header.Get("Content-Type")
	result.FinalURL = response.Request.URL.String()
	result.Redirects = redirects
	result.Headers = flatten(response.Header)
	for _, cookie := range response.Cookies() {
		result.SetCookies = append(result.SetCookies, cookie.String())
	}

	reader := io.Reader(response.Body)
	if spec.Options.ProgressEvents {
		reader = &progressReader{reader: reader, emitter: emitter, requestID: spec.RequestID}
	}
	payload, readErr := io.ReadAll(io.LimitReader(reader, spec.Options.MaxBodyBytes+1))
	if readErr != nil {
		if ctx.Err() != nil {
			result.Error = classifyError(ctx.Err())
			result.OK = false
			result.DurationMs = msSince(started)
			return result
		}
		result.BodyReadError = readErr.Error()
	}
	if int64(len(payload)) > spec.Options.MaxBodyBytes {
		payload = payload[:spec.Options.MaxBodyBytes]
		result.BodyTruncated = true
		result.Notice = fmt.Sprintf("响应体超过 %s，仅保留前 %s", humanBytes(spec.Options.MaxBodyBytes), humanBytes(spec.Options.MaxBodyBytes))
	}

	result.SizeBytes = int64(len(payload))
	result.DurationMs = msSince(started)
	result.BodyID = e.bodies.put(payload, result.ContentType)
	preview := payload
	if len(preview) > maxPreviewBytes {
		preview = preview[:maxPreviewBytes]
	}
	result.BodyPreviewBase64 = base64.StdEncoding.EncodeToString(preview)
	result.BodyPreviewBytes = len(preview)
	result.Metadata = map[string]string{
		"protocol":     result.HTTPVersion,
		"contentType":  result.ContentType,
		"remoteAddr":   response.Request.URL.Host,
		"redirectHops": fmt.Sprintf("%d", len(redirects)),
	}
	return result
}

// transportFor returns a pooled transport; connections are reused per
// (TLS verification, proxy) combination.
func (e *executor) transportFor(spec *sendRequest) (*http.Transport, *requestError) {
	proxyFunc, proxyKey, proxyErr := resolveProxy(spec.Options)
	if proxyErr != nil {
		return nil, proxyErr
	}
	key := transportKey{verifyTLS: boolOr(spec.Options.VerifyTLS, true), proxy: proxyKey}
	e.transportMu.Lock()
	defer e.transportMu.Unlock()
	if transport, ok := e.transports[key]; ok {
		return transport, nil
	}
	transport := &http.Transport{
		Proxy:                 proxyFunc,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}
	if !key.verifyTLS {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // explicit, per-request user opt-in surfaced in the UI
	}
	e.transports[key] = transport
	return transport, nil
}

func resolveProxy(options requestOptions) (func(*http.Request) (*url.URL, error), string, *requestError) {
	switch options.ProxyMode {
	case "direct":
		return nil, "direct", nil
	case "custom":
		raw := strings.TrimSpace(options.ProxyURL)
		if raw == "" {
			return nil, "", newRequestError("invalid-proxy", "代理模式为自定义，但未填写代理地址")
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Host == "" {
			return nil, "", newRequestError("invalid-proxy", "代理地址无法解析："+raw)
		}
		switch strings.ToLower(parsed.Scheme) {
		case "http", "https", "socks5", "socks5h":
		default:
			return nil, "", newRequestError("invalid-proxy", "不支持的代理协议："+parsed.Scheme)
		}
		return http.ProxyURL(parsed), "custom:" + parsed.String(), nil
	default:
		return http.ProxyFromEnvironment, "environment", nil
	}
}

type progressReader struct {
	reader    io.Reader
	emitter   *dbxpluginsdk.Emitter
	requestID string
	received  int64
	lastSent  int64
}

func (p *progressReader) Read(buffer []byte) (int, error) {
	count, err := p.reader.Read(buffer)
	if count > 0 {
		p.received += int64(count)
		if p.received-p.lastSent >= progressGranularity {
			p.lastSent = p.received
			p.emitter.Event("http/progress", map[string]any{
				"requestId": p.requestID,
				"phase":     "receiving",
				"received":  p.received,
			})
		}
	}
	return count, err
}

func statusText(response *http.Response) string {
	if response.Status == "" {
		return http.StatusText(response.StatusCode)
	}
	parts := strings.SplitN(response.Status, " ", 2)
	if len(parts) == 2 {
		return parts[1]
	}
	return response.Status
}

func httpVersion(response *http.Response) string {
	value := response.Proto
	value = strings.TrimPrefix(value, "HTTP/")
	return value
}

func classifyError(err error) *requestError {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return newRequestError("timeout", "请求超时：服务器在规定时间内没有返回结果")
	case errors.Is(err, context.Canceled):
		return newRequestError("canceled", "请求已被取消")
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return newRequestError("dns", "域名解析失败："+dnsErr.Error())
	}
	var hostnameErr x509.HostnameError
	var authorityErr x509.UnknownAuthorityError
	var invalidErr x509.CertificateInvalidError
	if errors.As(err, &hostnameErr) || errors.As(err, &authorityErr) || errors.As(err, &invalidErr) {
		return newRequestError("tls", "TLS 证书校验失败："+err.Error())
	}
	var recordErr tls.RecordHeaderError
	if errors.As(err, &recordErr) || strings.Contains(err.Error(), "x509") || strings.Contains(err.Error(), "certificate") {
		return newRequestError("tls", "TLS 握手失败："+err.Error())
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return newRequestError("connection", "连接失败："+err.Error())
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return newRequestError("invalid-url", err.Error())
	}
	return newRequestError("network", err.Error())
}

func (p *plugin) handleSend(params json.RawMessage, emitter *dbxpluginsdk.Emitter) (any, *dbxpluginsdk.PluginError) {
	var spec sendRequest
	raw := params
	if pluginErr := decodeParams(raw, &spec); pluginErr != nil {
		return nil, pluginErr
	}
	spec.normalize()
	if spec.RequestID == "" {
		spec.RequestID = fmt.Sprintf("req-%d", time.Now().UnixNano())
	}
	return p.executor.execute(&spec, emitter), nil
}

func (p *plugin) handleCancel(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var payload struct {
		RequestID string `json:"requestId"`
	}
	if pluginErr := decodeParams(params, &payload); pluginErr != nil {
		return nil, pluginErr
	}
	return map[string]any{"cancelled": p.executor.cancel(payload.RequestID)}, nil
}

func (p *plugin) handleReadBody(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var payload struct {
		BodyID string `json:"bodyId"`
		Offset int64  `json:"offset"`
		Length int64  `json:"length"`
	}
	if pluginErr := decodeParams(params, &payload); pluginErr != nil {
		return nil, pluginErr
	}
	entry, ok := p.executor.bodies.get(payload.BodyID)
	if !ok {
		return nil, dbxpluginsdk.NewError(-32004, "响应体已过期或不存在："+payload.BodyID)
	}
	total := int64(len(entry.payload))
	offset := payload.Offset
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	length := payload.Length
	if length <= 0 || length > maxChunkBytes {
		length = maxChunkBytes
	}
	end := offset + length
	if end > total {
		end = total
	}
	chunk := entry.payload[offset:end]
	return map[string]any{
		"bodyId":      payload.BodyID,
		"offset":      offset,
		"length":      len(chunk),
		"totalBytes":  total,
		"eof":         end >= total,
		"dataBase64":  base64.StdEncoding.EncodeToString(chunk),
		"contentType": entry.contentType,
	}, nil
}

func (p *plugin) handleSaveBody(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var payload struct {
		BodyID    string `json:"bodyId"`
		Directory string `json:"directory"`
		FileName  string `json:"fileName"`
	}
	if pluginErr := decodeParams(params, &payload); pluginErr != nil {
		return nil, pluginErr
	}
	entry, ok := p.executor.bodies.get(payload.BodyID)
	if !ok {
		return nil, dbxpluginsdk.NewError(-32004, "响应体已过期或不存在："+payload.BodyID)
	}
	name := sanitizeFileName(payload.FileName)
	if name == "" {
		name = "response-" + time.Now().Format("20060102-150405") + guessExtension(entry.contentType)
	}
	directory := strings.TrimSpace(payload.Directory)
	if directory == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, dbxpluginsdk.NewError(-32000, "无法定位用户主目录："+err.Error())
		}
		directory = filepath.Join(home, "Downloads")
	}
	if !filepath.IsAbs(directory) {
		return nil, dbxpluginsdk.NewError(-32602, "保存目录必须是绝对路径")
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "创建目录失败："+err.Error())
	}
	target := filepath.Join(directory, name)
	if err := os.WriteFile(target, entry.payload, 0o644); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "写入文件失败："+err.Error())
	}
	return map[string]any{"path": target, "bytes": len(entry.payload)}, nil
}

func sanitizeFileName(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\\", "/")
	if index := strings.LastIndex(value, "/"); index >= 0 {
		value = value[index+1:]
	}
	if value == "" || value == "." || value == ".." {
		return ""
	}
	replacer := strings.NewReplacer("\x00", "", "\n", "", "\r", "")
	return replacer.Replace(value)
}

func guessExtension(contentType string) string {
	base := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch base {
	case "application/json":
		return ".json"
	case "text/html":
		return ".html"
	case "text/plain":
		return ".txt"
	case "text/css":
		return ".css"
	case "application/javascript", "text/javascript":
		return ".js"
	case "application/xml", "text/xml":
		return ".xml"
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/svg+xml":
		return ".svg"
	case "application/pdf":
		return ".pdf"
	default:
		return ".bin"
	}
}
