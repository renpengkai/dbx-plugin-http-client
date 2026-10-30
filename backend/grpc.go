package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net"
	"strings"
	"time"

	"github.com/fullstorydev/grpcurl"
	"github.com/golang/protobuf/proto"
	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/grpcreflect"
	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	reflectpb "google.golang.org/grpc/reflection/grpc_reflection_v1alpha"
	"google.golang.org/grpc/status"
)

type grpcReflectRequest struct {
	Target    string       `json:"target"`
	Plaintext *bool        `json:"plaintext"`
	VerifyTLS *bool        `json:"verifyTls"`
	Authority string       `json:"authority"`
	Headers   []headerPair `json:"headers"`
	TimeoutMs int          `json:"timeoutMs"`
}

type grpcSendRequest struct {
	RequestID string       `json:"requestId"`
	Target    string       `json:"target"`
	Method    string       `json:"method"`
	BodyJSON  string       `json:"bodyJson"`
	Plaintext *bool        `json:"plaintext"`
	VerifyTLS *bool        `json:"verifyTls"`
	Authority string       `json:"authority"`
	Headers   []headerPair `json:"headers"`
	TimeoutMs int          `json:"timeoutMs"`
}

func (p *plugin) handleGRPCReflect(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req grpcReflectRequest
	if err := decodeParams(params, &req); err != nil {
		return nil, err
	}
	target := strings.TrimSpace(req.Target)
	if target == "" {
		return nil, dbxpluginsdk.NewError(-32602, "缺少 gRPC target（host:port）")
	}
	timeout := clampTimeout(req.TimeoutMs)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	defer cancel()

	conn, err := dialGRPC(ctx, target, boolOr(req.Plaintext, true), boolOr(req.VerifyTLS, true), strings.TrimSpace(req.Authority))
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "连接 gRPC 失败："+err.Error())
	}
	defer conn.Close()

	md := metadataFromPairs(req.Headers)
	refCtx := metadata.NewOutgoingContext(ctx, md)
	client := grpcreflect.NewClientV1Alpha(refCtx, reflectpb.NewServerReflectionClient(conn))
	defer client.Reset()

	services, err := client.ListServices()
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "服务反射失败："+err.Error())
	}

	descSource := grpcurl.DescriptorSourceFromServer(ctx, client)
	outServices := make([]map[string]any, 0, len(services))
	for _, serviceName := range services {
		if serviceName == "grpc.reflection.v1alpha.ServerReflection" || serviceName == "grpc.reflection.v1.ServerReflection" {
			continue
		}
		methods, methodErr := grpcurl.ListMethods(descSource, serviceName)
		if methodErr != nil {
			outServices = append(outServices, map[string]any{
				"name":    serviceName,
				"methods": []any{},
				"error":   methodErr.Error(),
			})
			continue
		}
		methodRows := make([]map[string]any, 0, len(methods))
		for _, fullName := range methods {
			short := fullName
			if idx := strings.LastIndex(fullName, "."); idx >= 0 {
				short = fullName[idx+1:]
			}
			methodRows = append(methodRows, map[string]any{
				"name":     short,
				"fullName": fullName,
			})
		}
		outServices = append(outServices, map[string]any{
			"name":    serviceName,
			"methods": methodRows,
		})
	}
	return map[string]any{
		"ok":       true,
		"target":   target,
		"services": outServices,
	}, nil
}

func (p *plugin) handleGRPCSend(params json.RawMessage, emitter *dbxpluginsdk.Emitter) (any, *dbxpluginsdk.PluginError) {
	var req grpcSendRequest
	if err := decodeParams(params, &req); err != nil {
		return nil, err
	}
	target := strings.TrimSpace(req.Target)
	method := strings.TrimSpace(req.Method)
	if target == "" {
		return failedGRPCResult(req, "invalid-url", "缺少 gRPC target（host:port）"), nil
	}
	if method == "" {
		return failedGRPCResult(req, "invalid-url", "缺少 gRPC method（package.Service/Method）"), nil
	}
	method = normalizeGRPCMethod(method)
	timeout := clampTimeout(req.TimeoutMs)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	defer cancel()
	if req.RequestID != "" {
		p.executor.register(req.RequestID, cancel)
		defer p.executor.unregister(req.RequestID)
	}

	started := time.Now()
	conn, err := dialGRPC(ctx, target, boolOr(req.Plaintext, true), boolOr(req.VerifyTLS, true), strings.TrimSpace(req.Authority))
	if err != nil {
		return failedGRPCResult(req, classifyDialError(err), err.Error()), nil
	}
	defer conn.Close()

	md := metadataFromPairs(req.Headers)
	refCtx := metadata.NewOutgoingContext(ctx, md)
	client := grpcreflect.NewClientV1Alpha(refCtx, reflectpb.NewServerReflectionClient(conn))
	defer client.Reset()
	descSource := grpcurl.DescriptorSourceFromServer(ctx, client)

	body := strings.TrimSpace(req.BodyJSON)
	if body == "" {
		body = "{}"
	}
	if !json.Valid([]byte(body)) {
		return failedGRPCResult(req, "invalid-body", "请求体必须是合法 JSON"), nil
	}

	rf, formatter, formatErr := grpcurl.RequestParserAndFormatter(grpcurl.FormatJSON, descSource, strings.NewReader(body), grpcurl.FormatOptions{
		EmitJSONDefaultFields: true,
		AllowUnknownFields:    true,
	})
	if formatErr != nil {
		return failedGRPCResult(req, "invalid-body", formatErr.Error()), nil
	}

	collector := &grpcEventCollector{formatter: formatter}
	if emitter != nil && req.RequestID != "" {
		emitter.Event("http/progress", map[string]any{"requestId": req.RequestID, "phase": "sending"})
	}
	invokeErr := grpcurl.InvokeRPC(ctx, descSource, conn, method, metadataPairs(req.Headers), collector, rf.Next)
	duration := time.Since(started).Milliseconds()
	if emitter != nil && req.RequestID != "" {
		emitter.Event("http/progress", map[string]any{
			"requestId": req.RequestID,
			"phase":     "receiving",
			"received":  int64(len(strings.Join(collector.messages, ""))),
		})
	}

	result := &sendResult{
		RequestID:          req.RequestID,
		OK:                 invokeErr == nil && (collector.stat == nil || collector.stat.Code() == codes.OK),
		Method:             method,
		URL:                "grpc://" + target + method,
		FinalURL:           "grpc://" + target + method,
		HTTPVersion:        "gRPC",
		DurationMs:         duration,
		FirstByteMs:        duration,
		ContentType:        "application/json",
		Headers:            metadataToHeaders(collector.headers),
		RequestHeaders:     pairsToOut(req.Headers),
		RequestBodyPreview: truncateString(body, maxRequestBodyInline),
		SetCookies:         metadataValues(collector.trailers, "set-cookie"),
		Metadata: map[string]string{
			"protocol": "grpc",
			"target":   target,
			"method":   method,
		},
	}

	if invokeErr != nil {
		result.OK = false
		if st, ok := status.FromError(invokeErr); ok {
			result.Status = int(st.Code())
			result.StatusText = st.Code().String()
			result.Error = newRequestError(grpcCodeKind(st.Code()), st.Message())
		} else {
			result.Error = newRequestError(classifyDialError(invokeErr), invokeErr.Error())
		}
	} else if collector.stat != nil && collector.stat.Code() != codes.OK {
		result.OK = false
		result.Status = int(collector.stat.Code())
		result.StatusText = collector.stat.Code().String()
		result.Error = newRequestError(grpcCodeKind(collector.stat.Code()), collector.stat.Message())
	} else {
		result.Status = 0
		result.StatusText = codes.OK.String()
	}

	payload := []byte("{}")
	switch len(collector.messages) {
	case 0:
		// keep empty object
	case 1:
		payload = []byte(collector.messages[0])
	default:
		joined, _ := json.Marshal(collector.messages)
		payload = joined
	}
	result.SizeBytes = int64(len(payload))
	result.BodyID = p.executor.bodies.put(payload, bodyMeta{
		contentType: result.ContentType,
		finalURL:    result.FinalURL,
	})
	preview := payload
	if len(preview) > maxPreviewBytes {
		preview = preview[:maxPreviewBytes]
		result.BodyTruncated = true
	}
	result.BodyPreviewBase64 = base64.StdEncoding.EncodeToString(preview)
	result.BodyPreviewBytes = len(preview)
	return result, nil
}

type grpcEventCollector struct {
	formatter grpcurl.Formatter
	headers   metadata.MD
	trailers  metadata.MD
	messages  []string
	stat      *status.Status
}

func (h *grpcEventCollector) OnResolveMethod(_ *desc.MethodDescriptor) {}
func (h *grpcEventCollector) OnSendHeaders(_ metadata.MD)              {}
func (h *grpcEventCollector) OnReceiveHeaders(md metadata.MD)          { h.headers = md }
func (h *grpcEventCollector) OnReceiveResponse(msg proto.Message) {
	if h.formatter != nil {
		if text, err := h.formatter(msg); err == nil {
			h.messages = append(h.messages, text)
			return
		}
	}
	raw, _ := json.Marshal(msg)
	h.messages = append(h.messages, string(raw))
}
func (h *grpcEventCollector) OnReceiveTrailers(stat *status.Status, md metadata.MD) {
	h.stat = stat
	h.trailers = md
}

func dialGRPC(ctx context.Context, target string, plaintext, verifyTLS bool, authority string) (*grpc.ClientConn, error) {
	hostPort := target
	hostPort = strings.TrimPrefix(hostPort, "grpc://")
	hostPort = strings.TrimPrefix(hostPort, "grpcs://")
	hostPort = strings.TrimSuffix(hostPort, "/")
	opts := []grpc.DialOption{
		grpc.WithBlock(),
		grpc.WithUserAgent("dbx-plugin-http-client/" + pluginVersion),
	}
	if authority != "" {
		opts = append(opts, grpc.WithAuthority(authority))
	}
	if plaintext {
		opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	} else {
		opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			InsecureSkipVerify: !verifyTLS, //nolint:gosec // intentional for API debugging
			MinVersion:         tls.VersionTLS12,
			ServerName:         authorityOrHost(authority, hostPort),
		})))
	}
	dialer := &net.Dialer{}
	opts = append(opts, grpc.WithContextDialer(func(ctx context.Context, addr string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp", addr)
	}))
	return grpc.DialContext(ctx, hostPort, opts...)
}

func authorityOrHost(authority, hostPort string) string {
	if authority != "" {
		return authority
	}
	host, _, err := net.SplitHostPort(hostPort)
	if err != nil {
		return hostPort
	}
	return host
}

func normalizeGRPCMethod(method string) string {
	method = strings.TrimSpace(method)
	method = strings.TrimPrefix(method, "/")
	if strings.Contains(method, "/") {
		return "/" + method
	}
	if idx := strings.LastIndex(method, "."); idx > 0 {
		return "/" + method[:idx] + "/" + method[idx+1:]
	}
	return "/" + method
}

func metadataFromPairs(pairs []headerPair) metadata.MD {
	md := metadata.MD{}
	for _, pair := range pairs {
		if !pair.active() {
			continue
		}
		key := strings.TrimSpace(pair.Key)
		if key == "" {
			continue
		}
		md.Append(strings.ToLower(key), pair.Value)
	}
	return md
}

func metadataPairs(pairs []headerPair) []string {
	out := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		if !pair.active() {
			continue
		}
		key := strings.TrimSpace(pair.Key)
		if key == "" {
			continue
		}
		out = append(out, key+": "+pair.Value)
	}
	return out
}

func metadataToHeaders(md metadata.MD) []headerOut {
	if len(md) == 0 {
		return []headerOut{}
	}
	out := make([]headerOut, 0)
	for key, values := range md {
		for _, value := range values {
			out = append(out, headerOut{Key: key, Value: value})
		}
	}
	return out
}

func metadataValues(md metadata.MD, key string) []string {
	if len(md) == 0 {
		return nil
	}
	return append([]string{}, md.Get(key)...)
}

func pairsToOut(pairs []headerPair) []headerOut {
	out := make([]headerOut, 0, len(pairs))
	for _, pair := range pairs {
		if !pair.active() {
			continue
		}
		out = append(out, headerOut{Key: pair.Key, Value: pair.Value})
	}
	return out
}

func failedGRPCResult(req grpcSendRequest, kind, message string) *sendResult {
	return &sendResult{
		RequestID: req.RequestID,
		OK:        false,
		Error:     newRequestError(kind, message),
		Method:    req.Method,
		URL:       "grpc://" + strings.TrimSpace(req.Target),
		Metadata:  map[string]string{"protocol": "grpc"},
	}
}

func classifyDialError(err error) string {
	if err == nil {
		return "network"
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "canceled"), strings.Contains(msg, "cancelled"):
		return "canceled"
	case strings.Contains(msg, "deadline"), strings.Contains(msg, "timeout"):
		return "timeout"
	case strings.Contains(msg, "tls"), strings.Contains(msg, "certificate"), strings.Contains(msg, "x509"):
		return "tls"
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "dns"):
		return "dns"
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "connect:"):
		return "connection"
	default:
		return "network"
	}
}

func grpcCodeKind(code codes.Code) string {
	switch code {
	case codes.Canceled:
		return "canceled"
	case codes.DeadlineExceeded:
		return "timeout"
	case codes.Unavailable:
		return "connection"
	default:
		return "network"
	}
}

func truncateString(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func clampTimeout(ms int) int {
	if ms < minTimeoutMs {
		return defaultTimeoutMs
	}
	if ms > maxTimeoutMs {
		return maxTimeoutMs
	}
	return ms
}
