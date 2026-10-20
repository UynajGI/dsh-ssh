# dsh-ssh

[English](README.md) | 中文

<p align="center">
  <img src="https://img.shields.io/npm/v/dsh-ssh" alt="npm 版本">
  <img src="https://img.shields.io/npm/l/dsh-ssh" alt="许可证">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node 版本">
  <img src="https://img.shields.io/github/actions/workflow/status/UynajGI/dsh-ssh/ci.yml?label=CI" alt="CI 状态">
  <img src="https://img.shields.io/github/stars/UynajGI/dsh-ssh" alt="GitHub Stars">
  <img src="https://img.shields.io/badge/dsh-plugin-2ea44f" alt="dsh-plugin">
</p>

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 SSH 远程开发插件**。把 Bash / 文件工具 / PTY 终端 / LSP 整体切到远程主机，支持跳板链（ProxyJump）、SFTP 上传下载、远程 subprocess 与交互终端。基于 [ssh2](https://github.com/mscdex/ssh2)。

## 工作原理

框架留在本地，只有命令与文件操作跑在远端。dsh-ssh 实现 deepseek-harness 两个能力缝隙（capability seam）的远程 provider——`ctx.subprocess`（远程进程）与 `ctx.fs`（远程文件）。框架里所有消费这两个缝隙的工具（bash、文件读写、终端、LSP、子代理进程）**零改动**自动切到远端执行：模型在本地思考，命令在远程跑，结果回传本地进模型上下文。

```
本地  (deepseek-harness)               SSH            远程主机
agent loop · LLM 调用 · 会话   ⇄  exec/pty/sftp  ⇄  bash · 文件(SFTP) · PTY · LSP
```

## 安装

用 DSH 的插件管理器安装，bundle 会被**安装并选中**：

- **Web**：左侧 **插件** → **添加插件** → 搜索 `dsh-ssh`（或选择本地路径 / Git 地址 / tarball）。
- **CLI**（在 profile 目录里转发 pnpm）：

  ```sh
  dsh plugin --profile web add dsh-ssh
  dsh plugin --profile web add link:/absolute/path/to/dsh-ssh   # 本地 checkout（先构建）
  dsh plugin --profile web why dsh-ssh
  dsh plugin --profile web remove dsh-ssh
  ```

安装会写入 profile 的 `package.json` 与 `dsh.profile.bundles` 选择，不需要手改 `cordis.yml`。HMR 开启时立即生效，否则重启 profile。选中 bundle 会应用包内的 [`cordis.patch.yml`](cordis.patch.yml)：挂载 SSH provider 与「添加工作区」选择器，并禁用默认选择器。其中 `ssh-remote` 行是占位配置——真实连接在 Web 的「**添加工作区**」里创建。

`package.json` 声明 `engines.dsh`（`>=0.2.0-rc.2 <0.3.0`）；不兼容的 DSH 宿主会在安装前被拒绝。

普通 npm 依赖（`npm i dsh-ssh`）不会自动选中 bundle；需自己加进 `dsh.profile.bundles`。

## 环境要求

- **DeepSeek Harness 0.2.x** — 在 `0.2.1-rc.2` 上验证。
- **Node.js ≥ 22**。
- 从 harness 宿主机可达的 SSH 端点；远端只需要 POSIX 登录 shell 与 SFTP。

## 配置

**一行挂载全部**——共享连接 + 两个远程 provider：

```yaml
- id: ssh-remote
  name: dsh-ssh
  config:
    host: server.example.com  # 目标主机，或 ~/.ssh/config 别名
    port: 22
    username: root            # 必填
    privateKey: ~/.ssh/id_ed25519   # 私钥文件路径，或直接写 PEM 内容
    # password: 'xxx'               # 密码认证（可与 privateKey 并存）
    # agent: 'pageant'              # Windows Pageant；Unix 填 SSH_AUTH_SOCK 路径
    cwd: /root/workspace           # 远程工作目录（必填，绝对 POSIX 路径）
    jump:                          # 可选跳板链（先连第一个跳板，最后连目标）
      - host: bastion.example.com
        privateKey: ~/.ssh/id_ed25519
    readyTimeout: 45000        # 等价 ConnectTimeout（毫秒）
    strictHostKeyChecking: false   # true 时校验主机指纹
```

聚合行等价于三个子路径行，只有需要单独组合 provider 时才分开挂载：`dsh-ssh/ssh`（连接）、`dsh-ssh/subprocess`（进程）、`dsh-ssh/fs`（文件）。

### 配置参考（`dsh-ssh/ssh`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` | string | — | 目标主机（必填） |
| `port` | number | 22 | 目标 SSH 端口 |
| `username` | string | — | 登录用户（必填） |
| `password` | string | — | 密码认证 |
| `privateKey` | string | — | PEM 私钥内容或本地私钥文件路径 |
| `passphrase` | string | — | 加密私钥的密码 |
| `agent` | string | — | ssh-agent socket 路径或 `pageant` |
| `jump` | JumpConfig[] | `[]` | 跳板链，每级可独立配 port/username/认证 |
| `cwd` | string | — | 远程工作目录（必填，绝对 POSIX 路径） |
| `readyTimeout` | number | 45000 | 连接超时（毫秒） |
| `keepaliveInterval` | number | 0 | SSH 层保活间隔（毫秒，0 禁用） |
| `keepaliveCountMax` | number | 3 | 保活失败判定次数 |
| `strictHostKeyChecking` | boolean | false | 是否校验主机指纹 |
| `knownHosts` | string[] | `[]` | 信任的主机指纹（`SHA256:…`）或原始 base64 公钥 |

### OpenSSH `~/.ssh/config` 映射

| OpenSSH 配置 | dsh-ssh 字段 |
|---|---|
| `HostName` / `Port` / `User` | `host` / `port` / `username` |
| `IdentityFile` / `IdentitiesOnly` | `privateKey` |
| `PasswordAuthentication` | `password` |
| `ForwardAgent` | `agent` |
| `ProxyJump`（逗号分隔多级） | `jump` 数组 |
| `ConnectTimeout` | `readyTimeout` |
| `ServerAliveInterval` / `ServerAliveCountMax` | `keepaliveInterval` / `keepaliveCountMax` |
| `StrictHostKeyChecking` + `UserKnownHostsFile` | `strictHostKeyChecking` + `knownHosts` |

## Web profile：让出本机 `subprocess` / `fs` 槽位

`subprocess` 与 `fs` 都是**单槽位**服务，而 Web 包默认挂载的本机 provider 会占住这两个槽位。若它们继续持有槽位，远程会话的命令与文件会**悄悄落到本机**（`ssh` 服务照常注册，看起来一切正常）。在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里释放槽位：

```yaml
# 让出槽位给 dsh-ssh 的远程 provider
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
  disabled: true
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true

# Windows 主机：远端是 POSIX，用 bash 工具而非 pwsh。
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: false
- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  disabled: true
```

本机写入不再有沙箱围栏（审批栈不受影响）。本插件按"整体替换"设计：同一实例里本机与远程工作区不能混用，想两边都用请用两套 profile。

## 界面上的「添加工作区」走 SSH（Web）

Web 的「**添加工作区**」流程变成**左侧连接侧栏 + 右侧目录浏览**：侧栏列出「`~/.ssh/config` 主机」「已保存连接」「本机目录」，右侧浏览当前选中的目标。`~/.ssh/config` 别名可一键直达——点击即解析配置、自动注册并直接进入该主机的目录浏览；别名未配 `User` 时改为打开预填表单。选中远程目录后，会话的 bash / 文件 / 终端工具都跑在该连接上（经本地占位 cwd）；远程会话不会写入 DSH 本地 workspace 注册表。

## 能力

| 能力 | 实现 |
|---|---|
| 跳板链 | `jump` 数组，多级跳板（direct-tcpip，等价 OpenSSH `ProxyJump`），每级独立认证 |
| 认证 | 密码、私钥（PEM/路径）、passphrase、ssh-agent / Pageant；未配置时回退 `~/.ssh` 默认私钥 |
| 读 / 写 | SFTP 原子写（同目录 staging + rename，保留 mode）；fs provider 全套（readText / streamText / readBytes / readByteRange / listDir / stat / lstat） |
| 远程命令 | subprocess provider：collect（tail 保留 + 本地 spill 文件）、pipe、inherit、批量 stdin |
| 交互终端 | PTY（`spawnTerminal`），I/O、`resize`、TERM→KILL 清理 |
| 环境隔离 | 远端登录环境 scrub（剔除 `DSH_*` 与凭据形变量）+ 显式 env 覆盖，`env -i` 启动 |
| 并发 / 安全 | fs 写按 targetKey 串行化；`strictHostKeyChecking` + `knownHosts` 校验主机 |

连接复用：三个 provider 共享一个 SSH 连接（含跳板链），SFTP 通道懒打开并复用；远程登录环境每连接只读一次，不再逐次探测；每条命令一条 exec 通道，无轮询。

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| `All configured authentication methods failed` | 认证配置错误：核对 username / privateKey 路径 / passphrase；私钥权限过宽（`chmod 600`） |
| `Host key verification failed` | `strictHostKeyChecking: true` 且 `knownHosts` 未含目标指纹；用 `ssh-keyscan` 获取后填入 |
| 跳板连接超时 | 检查跳板可达性与 `readyTimeout`；跳板机的 User/认证单独核对 |
| `Cannot read private key` | `privateKey` 不是 PEM 内容且文件路径不存在 |
| exec 返回 127 | 远程命令不存在；确认远程 PATH |
| 写文件报 `FS_NOT_OBSERVED` | 文件已存在且用了 `createIfAbsent`（防覆盖语义，非 bug） |
| 远程命令/文件落到了宿主机 | `subprocess` / `fs` 单槽位仍被本机 provider 占用——见上面的「Web profile 让出槽位」 |
| 插件管理器报 `not-a-bundle`，或 link 的 checkout 没有 `lib/` | 缺少 `dsh.bundle.patch` / `lib/`。本地 checkout 先 `npm ci && npm run build` 再 link |

## 已知限制

- **远端 pid 不可见 / 终止不保证进程树**：`pid` 恒为 `-1`；`terminate` 只作用于远程直接进程，不保证覆盖其子进程。
- **无前台进程组 / 无活动状态**：`inspectForeground` 为 `undefined`，`signalForeground` 不可用，`inspectActivity` 返回 `unknown`。
- **无 control 管道**：`SubprocessHandle.control` 为 `undefined`。
- **SSH 连接本身不重连**：远端 SSH 连接断开后其 `ready` promise 仍被缓存，需要重建连接；完整重启 DSH 宿主还可能需要刷新页面。
- **远程目录以会话落地**：远程会话经本地占位 cwd 打开，不会写入 DSH 本地 workspace 注册表。
- **POSIX 主机上选择器仅远程**：任何绝对路径都是远程路径（Windows 主机通过盘符/UNC 路由两者共存）。
- **`streamText` 仅文本**：二进制文件抛 `FS_NOT_TEXT`。

## 开发

```sh
npm i
npm run typecheck
npm run build       # 产出 lib/ —— harness 加载器实际导入的编译产物
```

- **目录结构**：`src/` 是 node 半边（provider、注册表、web channel）；`src/client/` 是浏览器半边。
- **Git hooks**（husky）：`pre-commit` 跑 typecheck；`commit-msg` 强制 [Conventional Commits](https://www.conventionalcommits.org/)；`pre-push` 拒绝与 `package.json` 版本不一致的版本 tag。
- **CI**：每次 push/PR 跑 typecheck + 发布载荷检查。
- **发布**：推送 `v*` tag 自动发布 npm 并生成 GitHub Release（使用 `NPM_TOKEN` automation token）：

```sh
npm version patch -m "chore(release): v%s"
git push origin main && git push origin --tags
```

## License

MIT
