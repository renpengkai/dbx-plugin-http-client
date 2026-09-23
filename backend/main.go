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
	"sync"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

const (
	pluginID      = "com.jettech.httpclient"
	pluginVersion = "0.1.4"
)

type plugin struct {
	executor *executor
	store    *storeManager

	connectionMu sync.Mutex
	connections  map[string]struct{}
}

// trackConnection records an open connection id so connection/disconnect can be
// acknowledged. The workbench itself stays usable without a connection (it is
// opened from the plugin list), so this is bookkeeping only.
func (p *plugin) trackConnection(id string) {
	if id == "" {
		return
	}
	p.connectionMu.Lock()
	if p.connections == nil {
		p.connections = map[string]struct{}{}
	}
	p.connections[id] = struct{}{}
	p.connectionMu.Unlock()
}

func (p *plugin) dropConnection(id string) {
	if id == "" {
		return
	}
	p.connectionMu.Lock()
	delete(p.connections, id)
	p.connectionMu.Unlock()
}

func (p *plugin) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	emitter *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	// Every inbound payload may carry the storage directory (connection/connect,
	// store/save, ...): scan it before dispatch so a path in any shape lands.
	if method != "store/save" {
		absorbParams(params)
	}
	switch method {
	case "plugin/ping":
		return map[string]any{
			"ok":         true,
			"plugin":     pluginID,
			"version":    pluginVersion,
			"dir":        storeDir(),
			"configured": dirConfigured(),
		}, nil
	case "http/send":
		return p.handleSend(params, emitter)
	case "http/cancel":
		return p.handleCancel(params)
	case "http/body":
		return p.handleReadBody(params)
	case "http/body/save":
		return p.handleSaveBody(params)
	case "connection/test":
		return p.handleConnectionTest()
	case "connection/connect":
		return p.handleConnectionConnect(params)
	case "connection/disconnect":
		return p.handleConnectionDisconnect(params)
	case "store/load":
		return p.handleStoreLoad()
	case "store/save":
		return p.handleStoreSave(params)
	case "store/setDir":
		return p.handleStoreSetDir(params)
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
	loadConfig()
	instance := &plugin{
		executor: newExecutor(),
		store:    newStoreManager(),
	}
	metadata := dbxpluginsdk.Metadata{
		ID:           pluginID,
		Version:      pluginVersion,
		Capabilities: []string{"http", "events", "connections", "storage"},
	}
	server := dbxpluginsdk.NewServer(metadata, instance)
	if err := server.Serve(); err != nil {
		log.Fatal(err)
	}
}
