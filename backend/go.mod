module github.com/jettech/dbx-plugin-http-client

go 1.22

require (
	github.com/fullstorydev/grpcurl v1.9.1
	github.com/golang/protobuf v1.5.4
	github.com/jhump/protoreflect v1.16.0
	github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk v0.1.0
	google.golang.org/grpc v1.65.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/bufbuild/protocompile v0.10.0 // indirect
	github.com/cncf/xds/go v0.0.0-20240423153145-555b57ec207b // indirect
	github.com/envoyproxy/go-control-plane v0.12.0 // indirect
	github.com/envoyproxy/protoc-gen-validate v1.0.4 // indirect
	github.com/kr/text v0.2.0 // indirect
	github.com/rogpeppe/go-internal v1.12.0 // indirect
	golang.org/x/net v0.25.0 // indirect
	golang.org/x/sync v0.7.0 // indirect
	golang.org/x/sys v0.20.0 // indirect
	golang.org/x/text v0.15.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20240528184218-531527333157 // indirect
	google.golang.org/protobuf v1.34.2 // indirect
)

replace github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk => ./third_party/dbx-plugin-sdk

exclude github.com/rogpeppe/go-internal v1.14.0

exclude github.com/rogpeppe/go-internal v1.14.1

exclude github.com/rogpeppe/go-internal v1.15.0

exclude github.com/rogpeppe/go-internal v1.16.0
