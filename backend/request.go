package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"
)

const (
	defaultTimeoutMs     = 30000
	minTimeoutMs         = 500
	maxTimeoutMs         = 115000 // keeps the UI invoke timeout below the 120 s host bridge cap
	defaultMaxBodyBytes  = 32 << 20
	maxAllowedBodyBytes  = 64 << 20
	maxInlineFieldBytes  = 1 << 20 // the UI bridge rejects payloads above 2 MiB, base64 included
	defaultMaxRedirects  = 10
	maxAllowedRedirects  = 50
	maxPreviewBytes      = 256 << 10
	maxRequestBodyInline = 64 << 10
)

type headerPair struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled *bool  `json:"enabled,omitempty"`
}

func (h headerPair) active() bool {
	return h.Enabled == nil || *h.Enabled
}

type bodyField struct {
	Key        string `json:"key"`
	Value      string `json:"value"`
	Enabled    *bool  `json:"enabled,omitempty"`
	Kind       string `json:"kind"` // "text" (default) or "file"
	FileName   string `json:"fileName,omitempty"`
	DataBase64 string `json:"dataBase64,omitempty"`
}

func (f bodyField) active() bool {
	return f.Enabled == nil || *f.Enabled
}

type requestBody struct {
	Mode        string      `json:"mode"` // none | raw | urlencoded | formdata
	Raw         string      `json:"raw"`
	ContentType string      `json:"contentType"`
	Fields      []bodyField `json:"fields"`
}

type authConfig struct {
	Type     string `json:"type"` // none | basic | bearer | apikey
	Username string `json:"username"`
	Password string `json:"password"`
	Token    string `json:"token"`
	Key      string `json:"key"`
	Value    string `json:"value"`
	In       string `json:"in"` // header | query
}

type requestOptions struct {
	TimeoutMs      int    `json:"timeoutMs"`
	FollowRedirect *bool  `json:"followRedirects"`
	MaxRedirects   int    `json:"maxRedirects"`
	VerifyTLS      *bool  `json:"verifyTls"`
	MaxBodyBytes   int64  `json:"maxBodyBytes"`
	ProgressEvents bool   `json:"progressEvents"`
	ProxyMode      string `json:"proxyMode"` // environment | direct | custom
	ProxyURL       string `json:"proxyUrl"`
}

type sendRequest struct {
	RequestID string         `json:"requestId"`
	Method    string         `json:"method"`
	URL       string         `json:"url"`
	Headers   []headerPair   `json:"headers"`
	Body      requestBody    `json:"body"`
	Auth      authConfig     `json:"auth"`
	Options   requestOptions `json:"options"`
}

type requestError struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

func newRequestError(kind, message string) *requestError {
	return &requestError{Kind: kind, Message: message}
}

func boolOr(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func clampInt(value, minimum, maximum, fallback int) int {
	if value <= 0 {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func clampInt64(value, minimum, maximum, fallback int64) int64 {
	if value <= 0 {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func (spec *sendRequest) normalize() {
	spec.Method = strings.ToUpper(strings.TrimSpace(spec.Method))
	if spec.Method == "" {
		spec.Method = http.MethodGet
	}
	spec.URL = strings.TrimSpace(spec.URL)
	spec.Options.TimeoutMs = clampInt(spec.Options.TimeoutMs, minTimeoutMs, maxTimeoutMs, defaultTimeoutMs)
	spec.Options.MaxRedirects = clampInt(spec.Options.MaxRedirects, 0, maxAllowedRedirects, defaultMaxRedirects)
	spec.Options.MaxBodyBytes = clampInt64(spec.Options.MaxBodyBytes, 64<<10, maxAllowedBodyBytes, defaultMaxBodyBytes)
	if spec.Body.Mode == "" {
		spec.Body.Mode = "none"
	}
	if spec.Options.ProxyMode == "" {
		spec.Options.ProxyMode = "environment"
	}
}

// buildRequest turns the plugin RPC payload into a ready-to-send *http.Request.
func buildRequest(spec *sendRequest) (*http.Request, *requestError) {
	parsed, err := url.Parse(spec.URL)
	if err != nil {
		return nil, newRequestError("invalid-url", "URL 解析失败："+err.Error())
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme == "" {
		return nil, newRequestError("invalid-url", "URL 缺少协议前缀，请以 http:// 或 https:// 开头")
	}
	if scheme != "http" && scheme != "https" {
		return nil, newRequestError("invalid-url", fmt.Sprintf("不支持的协议 %q，仅允许 http 与 https", scheme))
	}
	if parsed.Host == "" {
		return nil, newRequestError("invalid-url", "URL 缺少主机名")
	}

	query := parsed.Query()
	if spec.Auth.Type == "apikey" && spec.Auth.In == "query" && spec.Auth.Key != "" {
		query.Set(spec.Auth.Key, spec.Auth.Value)
	}
	parsed.RawQuery = query.Encode()

	bodyReader, bodyLength, contentType, bodyError := buildBody(spec)
	if bodyError != nil {
		return nil, bodyError
	}

	request, err := http.NewRequest(spec.Method, parsed.String(), bodyReader)
	if err != nil {
		return nil, newRequestError("invalid-url", "构造请求失败："+err.Error())
	}
	if bodyLength >= 0 {
		request.ContentLength = bodyLength
	}

	for _, header := range spec.Headers {
		if !header.active() || strings.TrimSpace(header.Key) == "" {
			continue
		}
		request.Header.Add(strings.TrimSpace(header.Key), header.Value)
	}
	if contentType != "" && request.Header.Get("Content-Type") == "" {
		request.Header.Set("Content-Type", contentType)
	}

	switch spec.Auth.Type {
	case "basic":
		request.SetBasicAuth(spec.Auth.Username, spec.Auth.Password)
	case "bearer":
		if spec.Auth.Token != "" {
			request.Header.Set("Authorization", "Bearer "+spec.Auth.Token)
		}
	case "apikey":
		if spec.Auth.In != "query" && spec.Auth.Key != "" {
			request.Header.Set(spec.Auth.Key, spec.Auth.Value)
		}
	}
	return request, nil
}

func buildBody(spec *sendRequest) (io.Reader, int64, string, *requestError) {
	switch spec.Body.Mode {
	case "raw":
		if spec.Body.Raw == "" {
			return nil, 0, "", nil
		}
		payload := []byte(spec.Body.Raw)
		return bytes.NewReader(payload), int64(len(payload)), spec.Body.ContentType, nil
	case "urlencoded":
		values := url.Values{}
		for _, field := range spec.Body.Fields {
			if !field.active() || field.Key == "" {
				continue
			}
			values.Add(field.Key, field.Value)
		}
		payload := []byte(values.Encode())
		return bytes.NewReader(payload), int64(len(payload)), "application/x-www-form-urlencoded", nil
	case "formdata":
		return buildMultipartBody(spec.Body.Fields)
	default:
		return nil, 0, "", nil
	}
}

func buildMultipartBody(fields []bodyField) (io.Reader, int64, string, *requestError) {
	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	for _, field := range fields {
		if !field.active() || field.Key == "" {
			continue
		}
		if field.Kind == "file" {
			if field.DataBase64 == "" {
				return nil, 0, "", newRequestError("invalid-body", fmt.Sprintf("表单文件字段 %q 没有内容", field.Key))
			}
			decoded, err := base64.StdEncoding.DecodeString(field.DataBase64)
			if err != nil {
				return nil, 0, "", newRequestError("invalid-body", fmt.Sprintf("表单文件字段 %q 不是合法的 base64 数据", field.Key))
			}
			if len(decoded) > maxInlineFieldBytes {
				return nil, 0, "", newRequestError("invalid-body", fmt.Sprintf(
					"表单文件字段 %q 为 %s，超过 1 MiB 的界面传输上限；请改用后端直接上传的大文件方案",
					field.Key, humanBytes(int64(len(decoded)))))
			}
			fileName := field.FileName
			if fileName == "" {
				fileName = "blob"
			}
			header := textproto.MIMEHeader{}
			header.Set("Content-Disposition", fmt.Sprintf("form-data; name=\"%s\"; filename=\"%s\"",
				escapeQuotes(field.Key), escapeQuotes(fileName)))
			header.Set("Content-Type", http.DetectContentType(decoded))
			part, err := writer.CreatePart(header)
			if err != nil {
				return nil, 0, "", newRequestError("invalid-body", "写入 multipart 字段失败："+err.Error())
			}
			if _, err := part.Write(decoded); err != nil {
				return nil, 0, "", newRequestError("invalid-body", "写入 multipart 字段失败："+err.Error())
			}
			continue
		}
		if err := writer.WriteField(field.Key, field.Value); err != nil {
			return nil, 0, "", newRequestError("invalid-body", "写入表单字段失败："+err.Error())
		}
	}
	if err := writer.Close(); err != nil {
		return nil, 0, "", newRequestError("invalid-body", "结束 multipart 请求体失败："+err.Error())
	}
	return bytes.NewReader(buffer.Bytes()), int64(buffer.Len()), writer.FormDataContentType(), nil
}

func humanBytes(size int64) string {
	const unit = 1024
	if size < unit {
		return fmt.Sprintf("%d B", size)
	}
	value := float64(size)
	units := []string{"KiB", "MiB", "GiB"}
	for _, name := range units {
		value /= unit
		if value < unit {
			return fmt.Sprintf("%.1f %s", value, name)
		}
	}
	return fmt.Sprintf("%.1f TiB", value/unit)
}

// describeBody renders a size-bounded preview of the outgoing request body.
// totalBytes is the known payload length, or <= 0 when unknown.
func describeBody(reader io.Reader, totalBytes int64) string {
	if reader == nil {
		return ""
	}
	chunk, err := io.ReadAll(io.LimitReader(reader, maxRequestBodyInline))
	if closer, ok := reader.(io.Closer); ok {
		_ = closer.Close()
	}
	if err != nil || len(chunk) == 0 {
		return ""
	}
	text := string(chunk)
	if isProbablyBinary(text) {
		if totalBytes > 0 {
			return fmt.Sprintf("(二进制请求体，共 %s)", humanBytes(totalBytes))
		}
		return "(二进制请求体)"
	}
	if totalBytes > int64(len(chunk)) {
		text += fmt.Sprintf("\n… 共 %s", humanBytes(totalBytes))
	}
	return text
}

func isProbablyBinary(text string) bool {
	return strings.ContainsRune(text, '\x00')
}

// escapeQuotes escapes a value used inside a quoted HTTP header parameter.
func escapeQuotes(value string) string {
	return strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(value)
}

func deadlineFrom(timeoutMs int) time.Duration {
	return time.Duration(timeoutMs) * time.Millisecond
}
