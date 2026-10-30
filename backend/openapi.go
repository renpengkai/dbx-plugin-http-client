package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"gopkg.in/yaml.v3"
)

type openAPIImportRequest struct {
	Document   string `json:"document"`
	BaseURL    string `json:"baseUrl"`
	Collection string `json:"collectionName"`
}

func (p *plugin) handleOpenAPIImport(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req openAPIImportRequest
	if err := decodeParams(params, &req); err != nil {
		return nil, err
	}
	raw := strings.TrimSpace(req.Document)
	if raw == "" {
		return nil, dbxpluginsdk.NewError(-32602, "缺少 OpenAPI / Swagger 文档内容")
	}
	doc, err := parseOpenAPIDocument(raw)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "无法解析 OpenAPI 文档："+err.Error())
	}
	baseURL := strings.TrimSpace(req.BaseURL)
	if baseURL == "" {
		baseURL = openAPIBaseURL(doc)
	}
	name := strings.TrimSpace(req.Collection)
	if name == "" {
		name = openAPITitle(doc)
	}
	requests := openAPIRequests(doc, baseURL)
	return map[string]any{
		"ok": true,
		"collection": map[string]any{
			"name":     name,
			"requests": requests,
		},
		"count": len(requests),
		"info": map[string]any{
			"title":   openAPITitle(doc),
			"version": openAPIVersion(doc),
			"baseUrl": baseURL,
		},
	}, nil
}

func parseOpenAPIDocument(raw string) (map[string]any, error) {
	var doc map[string]any
	if strings.HasPrefix(raw, "{") || strings.HasPrefix(raw, "[") {
		if err := json.Unmarshal([]byte(raw), &doc); err != nil {
			return nil, err
		}
		return doc, nil
	}
	if err := yaml.Unmarshal([]byte(raw), &doc); err != nil {
		return nil, err
	}
	return doc, nil
}

func openAPITitle(doc map[string]any) string {
	if info, ok := doc["info"].(map[string]any); ok {
		if title, ok := info["title"].(string); ok && strings.TrimSpace(title) != "" {
			return strings.TrimSpace(title)
		}
	}
	return "OpenAPI Import"
}

func openAPIVersion(doc map[string]any) string {
	if v, ok := doc["openapi"].(string); ok {
		return v
	}
	if v, ok := doc["swagger"].(string); ok {
		return v
	}
	return ""
}

func openAPIBaseURL(doc map[string]any) string {
	if servers, ok := doc["servers"].([]any); ok && len(servers) > 0 {
		if server, ok := servers[0].(map[string]any); ok {
			if u, ok := server["url"].(string); ok {
				return strings.TrimRight(strings.TrimSpace(u), "/")
			}
		}
	}
	scheme := "https"
	if schemes, ok := doc["schemes"].([]any); ok && len(schemes) > 0 {
		if s, ok := schemes[0].(string); ok && s != "" {
			scheme = s
		}
	}
	host, _ := doc["host"].(string)
	basePath, _ := doc["basePath"].(string)
	host = strings.TrimSpace(host)
	basePath = strings.TrimSpace(basePath)
	if host == "" {
		return ""
	}
	if basePath == "" {
		basePath = "/"
	}
	if !strings.HasPrefix(basePath, "/") {
		basePath = "/" + basePath
	}
	return strings.TrimRight(fmt.Sprintf("%s://%s%s", scheme, host, basePath), "/")
}

func openAPIRequests(doc map[string]any, baseURL string) []map[string]any {
	paths, _ := doc["paths"].(map[string]any)
	if paths == nil {
		return []map[string]any{}
	}
	pathKeys := make([]string, 0, len(paths))
	for key := range paths {
		pathKeys = append(pathKeys, key)
	}
	sort.Strings(pathKeys)

	out := make([]map[string]any, 0)
	httpMethods := map[string]bool{
		"get": true, "post": true, "put": true, "patch": true,
		"delete": true, "head": true, "options": true, "trace": true,
	}
	for _, pathKey := range pathKeys {
		item, ok := paths[pathKey].(map[string]any)
		if !ok {
			continue
		}
		methodKeys := make([]string, 0)
		for method := range item {
			lower := strings.ToLower(method)
			if httpMethods[lower] {
				methodKeys = append(methodKeys, method)
			}
		}
		sort.Strings(methodKeys)
		for _, methodKey := range methodKeys {
			op, ok := item[methodKey].(map[string]any)
			if !ok {
				continue
			}
			method := strings.ToUpper(methodKey)
			name := firstNonEmpty(
				asString(op["summary"]),
				asString(op["operationId"]),
				method+" "+pathKey,
			)
			url := joinURL(baseURL, pathKey)
			headers := []map[string]any{}
			params := []map[string]any{}
			bodyMode := "none"
			bodyRaw := ""
			contentType := "application/json"

			for _, param := range collectParameters(item, op) {
				location := strings.ToLower(asString(param["in"]))
				key := asString(param["name"])
				example := parameterExample(param)
				switch location {
				case "header":
					headers = append(headers, map[string]any{"key": key, "value": example, "enabled": true})
				case "query":
					params = append(params, map[string]any{"key": key, "value": example, "enabled": true})
				case "path":
					if key != "" {
						url = strings.ReplaceAll(url, "{"+key+"}", exampleOrPlaceholder(example, key))
					}
				case "body":
					bodyMode = "raw"
					bodyRaw = prettyJSON(example)
					if bodyRaw == "" {
						bodyRaw = "{}"
					}
				}
			}

			if rb, ok := op["requestBody"].(map[string]any); ok {
				if content, ok := rb["content"].(map[string]any); ok {
					preferred := []string{"application/json", "application/xml", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"}
					chosenType := ""
					var chosen map[string]any
					for _, ct := range preferred {
						if media, ok := content[ct].(map[string]any); ok {
							chosenType = ct
							chosen = media
							break
						}
					}
					if chosen == nil {
						for ct, media := range content {
							if m, ok := media.(map[string]any); ok {
								chosenType = ct
								chosen = m
								break
							}
						}
					}
					if chosen != nil {
						contentType = chosenType
						switch chosenType {
						case "application/x-www-form-urlencoded":
							bodyMode = "urlencoded"
						case "multipart/form-data":
							bodyMode = "formdata"
						default:
							bodyMode = "raw"
							bodyRaw = schemaExampleJSON(chosen["schema"], chosen["example"], chosen["examples"])
						}
					}
				}
			}

			if len(headers) == 0 {
				headers = append(headers, map[string]any{"key": "", "value": "", "enabled": true})
			}
			if len(params) == 0 {
				params = append(params, map[string]any{"key": "", "value": "", "enabled": true})
			}

			out = append(out, map[string]any{
				"name":    name,
				"method":  method,
				"url":     url,
				"headers": headers,
				"params":  params,
				"body": map[string]any{
					"mode":        bodyMode,
					"raw":         bodyRaw,
					"contentType": contentType,
					"fields":      []any{},
				},
				"auth":    map[string]any{"type": "none"},
				"options": map[string]any{},
			})
		}
	}
	return out
}

func collectParameters(pathItem, op map[string]any) []map[string]any {
	out := make([]map[string]any, 0)
	appendParams := func(raw any) {
		list, ok := raw.([]any)
		if !ok {
			return
		}
		for _, item := range list {
			if param, ok := item.(map[string]any); ok {
				out = append(out, param)
			}
		}
	}
	appendParams(pathItem["parameters"])
	appendParams(op["parameters"])
	return out
}

func parameterExample(param map[string]any) string {
	if ex := param["example"]; ex != nil {
		return stringifyExample(ex)
	}
	if schema, ok := param["schema"].(map[string]any); ok {
		if ex := schema["example"]; ex != nil {
			return stringifyExample(ex)
		}
		if def := schema["default"]; def != nil {
			return stringifyExample(def)
		}
		if t, ok := schema["type"].(string); ok {
			switch t {
			case "integer", "number":
				return "0"
			case "boolean":
				return "false"
			case "array":
				return "item"
			}
		}
	}
	if def := param["default"]; def != nil {
		return stringifyExample(def)
	}
	return ""
}

func schemaExampleJSON(schema any, example any, examples any) string {
	if example != nil {
		return prettyJSON(example)
	}
	if examplesMap, ok := examples.(map[string]any); ok {
		for _, item := range examplesMap {
			if ex, ok := item.(map[string]any); ok {
				if value := ex["value"]; value != nil {
					return prettyJSON(value)
				}
			}
		}
	}
	if schemaMap, ok := schema.(map[string]any); ok {
		if ex := schemaMap["example"]; ex != nil {
			return prettyJSON(ex)
		}
		return prettyJSON(syntheticSchemaValue(schemaMap))
	}
	return "{}"
}

func syntheticSchemaValue(schema map[string]any) any {
	if t, ok := schema["type"].(string); ok {
		switch t {
		case "object":
			props, _ := schema["properties"].(map[string]any)
			obj := map[string]any{}
			for key, prop := range props {
				if propMap, ok := prop.(map[string]any); ok {
					obj[key] = syntheticSchemaValue(propMap)
				} else {
					obj[key] = ""
				}
			}
			return obj
		case "array":
			if items, ok := schema["items"].(map[string]any); ok {
				return []any{syntheticSchemaValue(items)}
			}
			return []any{}
		case "integer", "number":
			return 0
		case "boolean":
			return false
		default:
			return ""
		}
	}
	if props, ok := schema["properties"].(map[string]any); ok {
		obj := map[string]any{}
		for key, prop := range props {
			if propMap, ok := prop.(map[string]any); ok {
				obj[key] = syntheticSchemaValue(propMap)
			}
		}
		return obj
	}
	return map[string]any{}
}

func prettyJSON(value any) string {
	switch typed := value.(type) {
	case string:
		trimmed := strings.TrimSpace(typed)
		if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
			var decoded any
			if json.Unmarshal([]byte(trimmed), &decoded) == nil {
				encoded, err := json.MarshalIndent(decoded, "", "  ")
				if err == nil {
					return string(encoded)
				}
			}
		}
		return typed
	default:
		encoded, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return fmt.Sprint(value)
		}
		return string(encoded)
	}
}

func stringifyExample(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%d", int64(typed))
		}
		return fmt.Sprintf("%v", typed)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Sprint(value)
		}
		return string(encoded)
	}
}

func exampleOrPlaceholder(example, key string) string {
	if strings.TrimSpace(example) != "" {
		return example
	}
	return ":" + key
}

func joinURL(base, pathPart string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if pathPart == "" {
		return base
	}
	if strings.HasPrefix(pathPart, "http://") || strings.HasPrefix(pathPart, "https://") {
		return pathPart
	}
	if !strings.HasPrefix(pathPart, "/") {
		pathPart = "/" + pathPart
	}
	if base == "" {
		return pathPart
	}
	return base + pathPart
}

func asString(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
