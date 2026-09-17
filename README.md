# HTTP Client — DBX 插件

一个类似 Postman 的 DBX 工作台插件：构造 HTTP 请求、通过原生 Sidecar 发送、查看结构化响应，
并管理集合、环境变量与历史记录。

- 插件 ID：`com.jettech.httpclient`
- 贡献点：`workbench`（`com.jettech.httpclient.workbench`）
- 入口：`ui/index.html` + `bin/dbx-plugin-http-client`（Go Sidecar）
- 权限：`host.events`（仅用于接收 Sidecar 的下载进度事件）

---

## 1. 为什么必须有原生 Sidecar

插件的 UI 运行在 DBX 的沙箱 iframe 中，CSP 为 `connect-src 'none'`：
**界面本身无法发起任何网络请求**，即使声明 `host.network:<origin>` 也只能访问最多 8 个预声明
的 HTTPS origin，且受目标站点 CORS 约束——这显然无法支撑"任意 URL 的接口调试"。

因此本插件把网络能力下沉到 `backend/` 中的 Go Sidecar：

```
┌───────────────────────────── DBX 桌面端 ─────────────────────────────┐
│  sandbox iframe (ui/)                 Host Bridge                    │
│  ├─ 请求构造 / 变量替换 / 结果渲染  ⇄  dbxPlugin.invoke("http/send")  │
│  └─ 不持有 socket、不 fetch                │                          │
└────────────────────────────────────────────┼──────────────────────────┘
                                             ▼
                              stdio JSON Lines (protocol v1)
                                             ▼
                     backend/ (Go + net/http) ──► 目标 HTTP 服务
```

好处：任意 host/端口/协议头/自签名证书都能调试；响应体由 Sidecar 落盘或分块回传；
UI 侧不需要任何网络权限，攻击面更小。

## 2. 目录结构

```
dbx-http-client/
├── manifest.json                  # Manifest v1：身份、引擎、权限、入口、贡献点、中文文案
├── dbx-plugin.toml                # 打包配置：Go 后端 + 仅收录 assets/ 与 ui/
├── assets/plugin.svg              # 插件与工作台图标
├── ui/                            # 沙箱工作台（零依赖、零构建的经典脚本）
│   ├── index.html                 # 骨架：顶栏 / 侧栏 / 请求区 / 响应区
│   ├── app.css                    # 主题令牌 + 全部样式（明暗双色）
│   ├── i18n.js                    # zh-CN / en 文案与 t()
│   ├── util.js                    # DOM 助手、弹窗、Toast、KV 编辑器、JSON 高亮
│   ├── bridge.js                  # window.dbxPlugin 封装（唯一的宿主边界）
│   ├── store.js                   # 状态、持久化、集合/环境/历史、{{变量}} 解析
│   ├── curl.js                    # cURL 导入 / 导出
│   ├── view-sidebar.js            # 集合、历史、环境
│   ├── view-request.js            # 参数 / 请求头 / 请求体 / 认证 / 选项
│   ├── view-response.js           # 状态行、响应体、响应头、Cookie、请求回显
│   └── app.js                     # 标签页、工具栏、分栏拖动、快捷键、启动流程
├── backend/                       # Go Sidecar（protocol v1，stdio-jsonl）
│   ├── main.go                    # 方法路由
│   ├── request.go                 # 请求模型、URL/请求体/认证构造、代理解析
│   ├── execute.go                 # 执行、跳转链、错误分类、响应体仓库、分块读取
│   ├── store.go                   # 配置持久化（0600，原子写）
│   └── go.mod
├── tools/                         # 测试脚手架（不属于发布产物）
│   ├── sidecar-smoke-test.py      # 协议级冒烟测试：直连 Sidecar 跑 40+ 断言
│   ├── ui-e2e-test.mjs            # jsdom 端到端：真实 UI + 真实 Sidecar，33 项断言
│   ├── test-target-server.py      # 上述两个测试共用的目标 HTTP 服务器
│   └── run-ui-e2e.sh              # 一键跑端到端测试（自动起停目标服务器）
└── .github/workflows/plugin-release.yml
```

> `tools/` 里的脚本只用于本地验证，`dbx-plugin.toml` 的 `include` 未收录它们，因此不会进入 `.dbxp`。

## 3. 功能

**请求**

- 方法（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS/TRACE）+ URL 输入，`Enter` 直接发送
- 参数表与地址栏查询串**双向同步**；请求头支持一键预置常见头
- 请求体：无 / 原始文本（JSON/XML/文本，带格式化）/ `x-www-form-urlencoded` / `form-data`（含文件字段）
- 认证：Basic / Bearer / API Key（可放请求头或查询参数）
- 选项：超时、跟随跳转与最大跳转数、TLS 校验开关、代理（跟随环境变量 / 直连 / 自定义）、响应体上限
- 多标签页；`⌘/Ctrl+Enter` 发送、`⌘/Ctrl+S` 保存、`⌘/Ctrl+T` 新标签、`⌘/Ctrl+K` 聚焦地址栏
- 请求进行中可**取消**；接收阶段通过 `http/progress` 事件回传进度

**响应**

- 状态徽标（按 2xx/3xx/4xx/5xx 着色）、HTTP 版本、总耗时、TTFB、体积、跳转链路
- 视图：响应体（格式化 / 原始 / 预览）、响应头表、Cookie、请求回显（实际发出的头与体）
- JSON 语法高亮；图片响应可直接预览；文本响应可复制
- 超过 256 KiB 的预览会明确标注，可**分块加载完整响应**或让 Sidecar **直接保存到文件**
- 失败时渲染错误卡片：类型（超时 / 取消 / DNS / TLS / 连接 / URL 无效 / 网络）+ 原始报文

**组织与复用**

- 集合：保存 / 另存 / 重命名 / 删除 / 复制，JSON 导入导出
- 历史：最近 60 条，一键还原整条请求，可清空
- 环境：多环境变量表，`{{name}}` 在 URL、请求头、参数、请求体、认证字段中统一替换
- 内置动态变量：`{{$uuid}}`、`{{$timestamp}}`、`{{$isoTimestamp}}`、`{{$randomInt}}`、`{{$randomFloat}}`、`{{$randomBoolean}}`、`{{$randomString}}`
- cURL：一键复制当前请求为 cURL；粘贴 cURL 反向导入（`-X/-H/-d/-u/-F/--url/-k/-L/-x/--max-time/--data-urlencode/-G/-I/-b/-A/-e`）
- 中英双语；跟随 DBX 明暗主题令牌

## 4. RPC 协议

Sidecar 通过 stdout 的 JSON Lines 收发 protocol v1 报文；stdout 只留给协议，诊断一律走 stderr。

| 方法 | 请求参数 | 返回 |
| --- | --- | --- |
| `plugin/ping` | — | `{ ok, plugin, version }` |
| `http/send` | `{ requestId, method, url, headers[], body{mode,raw,contentType,fields[]}, auth{...}, options{...} }` | 见下方 `sendResult` |
| `http/cancel` | `{ requestId }` | `{ cancelled }` |
| `http/body` | `{ bodyId, offset, length≤512 KiB }` | `{ bodyId, offset, length, totalBytes, eof, dataBase64, contentType }` |
| `http/body/save` | `{ bodyId, directory?, fileName? }` | `{ path, bytes }`（目录默认 `~/Downloads`） |
| `store/load` | — | `{ path, store, exists }` |
| `store/save` | `{ store }` | `{ path, bytes, savedAt }` |

`body.mode`：`none` | `raw` | `urlencoded` | `formdata`；`fields[].kind`：`text` | `file`。
`auth.type`：`none` | `basic` | `bearer` | `apikey`（`in`: `header` | `query`）。
`options`：`timeoutMs`(500–115000)、`followRedirects`、`maxRedirects`(0–50)、`verifyTls`、
`maxBodyBytes`(64 KiB–64 MiB)、`progressEvents`、`proxyMode`(`environment`|`direct`|`custom`)、`proxyUrl`。

`sendResult` 关键字段：`ok`、`status`、`statusText`、`httpVersion`、`finalUrl`、`durationMs`、
`firstByteMs`、`sizeBytes`、`contentType`、`headers[]`、`setCookies[]`、`redirects[]`、
`requestHeaders[]`、`requestBodyPreview`、`bodyId`、`bodyPreviewBase64`、`bodyPreviewBytes`、
`bodyTruncated`；失败时 `ok:false` 且带 `error: { kind, message }`
（`kind` ∈ `timeout|canceled|dns|tls|connection|invalid-url|invalid-body|invalid-proxy|network`）。

事件（`host.events`）：`http/progress` → `{ requestId, phase: "sending"|"receiving", received? }`。

## 5. 数据与持久化

集合、环境（含 Token 等敏感值）、历史与界面设置写入本机配置文件：

- macOS：`~/Library/Application Support/dbx-http-client/store.json`
- Linux：`$XDG_CONFIG_HOME/dbx-http-client/store.json`
- Windows：`%AppData%\dbx-http-client\store.json`

文件权限 `0600`、目录 `0700`、写入为「临时文件 + 原子替换」，上限 4 MiB。
Sidecar 不可用时会退化为 localStorage（沙箱不支持时再退化为内存），设置面板会明确提示。

## 6. 开发与调试

需要 Node.js ≥ 22 与 Go ≥ 1.22（纯前端插件不需要 Go；本插件的网络能力依赖 Go Sidecar）。

```bash
# 1. 安装官方 CLI（自动携带匹配版本的 Go/Rust 插件 SDK）
npm install --global @dbx-app/plugin-cli

# 2. 浏览器开发宿主（会按 dbx-plugin.toml 构建 backend/ 并启动 Sidecar）
dbx-plugin dev --path . --port 5190
```

开发宿主不会替你安装依赖或翻译文案；`.dbx-dev/` 里是明文调试数据，已在 `.gitignore` 中。
改动 `ui/` 后刷新页面即可；改动 `backend/` 后重启 `dbx-plugin dev`。

协议级回归（推荐在打包前跑一遍，40+ 断言覆盖正常、边界与失败路径）：

```bash
go build -o dist/backend ./backend
python3 tools/sidecar-smoke-test.py dist/backend
```

## 7. 打包与发布

```bash
dbx-plugin package .
```

CLI 会为当前平台构建原生后端、暂存 `manifest.json` / `assets/` / `ui/`，并在 `dist/` 生成
未签名的 `.dbxp` 候选包与 `.artifact.json` 元数据。发布 GitHub Release 后，
`.github/workflows/plugin-release.yml` 会复用 `t8y2/dbx` 的可复用工作流，为各平台构建未签名候选产物；
商店审核通过后由 DBX Store 用官方仓库密钥签名并回写安装包。

> 只提交本仓库的源码与未签名候选包，不要向 `t8y2/dbx` 提交普通插件源码。

## 8. 测试

两层测试互相独立，覆盖不同问题域：

**协议层**——直连 Sidecar，完全绕开 UI：

```bash
go build -o dist/dbx-plugin-http-client ./backend
python3 tools/sidecar-smoke-test.py dist/dbx-plugin-http-client
```

覆盖 `plugin/ping`、各错误分类（超时 / 取消 / DNS / TLS / 连接 / URL 非法）、跳转链、204/404、
大响应分块读取与落盘、四类请求体、三种认证、gzip、进度事件、存储读写的边界条件。

**端到端**——把真实 UI 装进 jsdom，用模拟 Host Bridge 接到真实 Sidecar，像用户一样点：

```bash
./tools/run-ui-e2e.sh dist/dbx-plugin-http-client
```

覆盖启动握手、GET/POST、参数与地址栏双向同步、原始请求体、自定义头、Bearer 认证、错误卡片、
大响应截断与「加载完整响应」、跳转链路、环境变量解析、保存到集合、cURL 导入导出、中英文与明暗主题切换。

两个脚手架都要求 UI 以 `index.html` 中的顺序、用经典脚本加载。往文档里注入脚本时必须使用**函数式
replacer**（`replace(pattern, () => payload)`）——若用字符串替换，源码里的 `$$` 会被当成转义序列压成
单个 `$`，`function $$` 就会静默变成第二个 `function $` 并覆盖前者，症状是 `util.$()` 返回数组。
这正是 DBX dev host（`sandboxDocument`）采用函数式 replacer 的原因，端到端脚手架必须保持一致。

- **样式表也要内联**：dev host 会把 `<link rel=stylesheet>` 的内容读进文档，脚手架必须照做。
  jsdom 不实现 CSS 层叠与布局，天生抓不到视觉 bug，所以端到端测试只能退而求其次地断言
  「样式里存在 `[hidden]` 复位」——这条断言专门守着那个会让整块遮罩挡住工作台的坑。

路径与端口可用环境变量覆盖：`UI_DIR`、`SIDECAR`、`BASE`（端到端），`PORT`、`SCRATCH`（`run-ui-e2e.sh`），
`SMOKE_PORT`（协议测试）。

## 9. 安全边界与已知限制

- **沙箱不渲染响应 HTML**：宿主 CSP 禁止 iframe 子资源，插件也不会把响应 HTML 注入界面，
  查看 HTML 请切到「原始」。副作用是响应里的脚本永远不会在插件上下文中执行。
- **单次请求最长 115 秒**：Host Bridge 对 `invoke` 的 `timeoutMs` 上限为 120 秒，插件预留了 5 秒余量。
- **单次 RPC 体积上限 2 MiB**：`form-data` 的文件字段因此限制为 1 MiB（base64 后约 1.37 MiB），
  超出时界面与后端都会给出明确提示；更大的上传请改用分块/`stdio-framed` 二进制通道（尚未实现）。
- **响应体上限 64 MiB**：超过 `maxBodyBytes` 的部分被丢弃，响应头会提示；完整响应可在保存后查看。
- **代理默认跟随环境变量**：DBX 进程若带有 `HTTP_PROXY/HTTPS_PROXY`，请求默认会走代理；
  需要绕过时在「选项」里切换为「直连」。
- **凭证为本机明文**：环境变量与认证字段保存在 0600 配置文件中，不会上传；共享机器上请勿放入生产凭证。
- **TLS 校验可关闭**：关闭时错误卡片与选项面板都会提示，仅用于自签名调试。
- **未实现**：Cookie 会话保持、请求脚本/前置后置处理器、OAuth2、WebSocket/gRPC、证书文件导入、
  大文件流式上传。

## 10. 排错

| 现象 | 处理 |
| --- | --- |
| 发送按钮置灰、提示「Sidecar 后端不可用」 | 未在 DBX 中打开工作台（例如直接用浏览器打开了 `ui/index.html`），或后端未构建 |
| `Cannot start sidecar executable` | `bin/dbx-plugin-http-client` 不存在：先 `dbx-plugin package .` 或按第 6 节本地构建 |
| 打包时 Go 编译报找不到 SDK | 使用官方 CLI 打包（它会通过 `go.work` 注入随包 SDK），不要在 `go.mod` 里写本地 `replace` |
| 工作台整个被一层黑色遮罩盖住、点不动 | 浮层容器 `.hc-modal-layer` 设了 `display: grid`，压过了浏览器默认的 `[hidden] { display: none }`；`app.css` 里那条 `[hidden] { display: none !important; }` 全局复位被删掉了 |
| 改了 `ui/` 下的文件但页面没变 | dev host 的文件监听只覆盖后端源码与 `manifest.json`，不监听 `ui/`；手动刷新页面即可（每次构建 frame 都会重新从磁盘读取资源） |
| CSP 报错、界面空白 | 确认 `ui/` 内没有引用 CDN、外链字体或 ES module 之间的相对导入（宿主会把本地脚本内联为 `<script>`） |
