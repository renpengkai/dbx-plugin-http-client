// Command dbx-plugin-http-client is the native sidecar of the DBX "HTTP Client"
// workbench plugin.
//
// The sandboxed plugin UI cannot open sockets on its own (the workbench iframe
// runs under a restrictive CSP), so every byte of HTTP traffic in this plugin
// travels over protocol v1 (JSON Lines on stdin/stdout) to this process, which
// performs the actual request with net/http.
//
// stdout is reserved for protocol frames; all diagnostics go to stderr.
package main

import (
	"encoding/json"
	"log"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

const (
	pluginID      = "com.jettech.httpclient"
	pluginVersion = "0.1.0"
)

type plugin struct {
	executor *executor
	store    *storeManager
}

func (p *plugin) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	emitter *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	switch method {
	case "plugin/ping":
		return map[string]any{
			"ok":      true,
			"plugin":  pluginID,
			"version": pluginVersion,
		}, nil
	case "http/send":
		return p.handleSend(params, emitter)
	case "http/cancel":
		return p.handleCancel(params)
	case "http/body":
		return p.handleReadBody(params)
	case "http/body/save":
		return p.handleSaveBody(params)
	case "store/load":
		return p.handleStoreLoad()
	case "store/save":
		return p.handleStoreSave(params)
	default:
		return nil, dbxpluginsdk.MethodNotFound(method)
	}
}

func decodeParams(params json.RawMessage, target any) *dbxpluginsdk.PluginError {
	if len(params) == 0 || string(params) == "null" {
		return dbxpluginsdk.NewError(-32602, "Missing request parameters")
	}
	if err := json.Unmarshal(params, target); err != nil {
		return dbxpluginsdk.NewError(-32602, "Invalid request parameters: "+err.Error())
	}
	return nil
}

func main() {
	instance := &plugin{
		executor: newExecutor(),
		store:    newStoreManager(),
	}
	metadata := dbxpluginsdk.Metadata{
		ID:           pluginID,
		Version:      pluginVersion,
		Capabilities: []string{"http", "events"},
	}
	server := dbxpluginsdk.NewServer(metadata, instance)
	if err := server.Serve(); err != nil {
		log.Fatal(err)
	}
}
