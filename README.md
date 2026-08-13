# dsh-ssh

**DeepSeek Harness 的 SSH 远程开发插件**。把 Bash / 文件工具 / PTY 终端 / LSP 整体切到远程主机，支持跳板链（ProxyJump）、SFTP 上传下载、远程 subprocess 与交互终端。基于 [ssh2](https://github.com/mscdex/ssh2)。

> **当前状态**：dsh-plugin 生态中第一个（截至 2026-08 唯一）SSH 远程开发插件。已通过真实跳板环境（双跳、密钥认证、SFTP 读写）e2e 验证。

## 架构：本地大脑，远程手脚

```
你的本机 (deepseek-harness)                    远程主机
┌───────────────────────────────────┐   SSH   ┌──────────────────────┐
│ agent loop（模型编排、会话、日志） │◄────────►│  bash / 命令执行      │
│ LLM API 调用（本机直连，不出网）   │ exec    │  文件系统 (SFTP)      │
│ 凭证 / 配置 / 会话状态             │ pty     │  PTY 交互终端         │
│ ctx.subprocess → dsh-ssh          │ sftp    │  LSP / git / 编译     │
│ ctx.fs → dsh-ssh                  │         │                      │
└───────────────────────────────────┘         └──────────────────────┘
```

**不需要把 dsh 部署到远程。** dsh-ssh 实现的是 deepseek-harness 的两个能力缝隙（capability seam）的远程 provider——`ctx.subprocess`（远程进程）与 `ctx.fs`（远程文件）。框架里所有消费这两个缝隙的工具（bash、文件读写、终端、LSP、子代理进程）**零改动**自动切到远端执行：模型在本地思考，命令在远程跑，结果回传本地进模型上下文。

## 安装

```sh
npm i dsh-ssh
```

## 配置（cordis.yml）

三个插件，共用一个 SSH 连接：

```yaml
- id: ssh
  name: dsh-ssh/ssh
  config:
    host: 10.0.0.5            # 目标主机（必填）
    port: 22
    username: root            # 必填
    privateKey: ~/.ssh/id_ed25519   # 私钥文件路径，或直接写 PEM 内容
    # password: 'xxx'               # 密码认证（与 privateKey 二选一或并存）
    # agent: 'pageant'              # Windows Pageant；Unix 填 SSH_AUTH_SOCK 路径
    cwd: /root/workspace           # 远程工作目录（必填，绝对 POSIX 路径）
    # --- 跳板链（可选，按序：先连第一个跳板，最后连目标）---
    jump:
      - host: 47.xx.xx.1
        # port: 22             # 缺省跟随目标机
        # username: ubuntu     # 缺省跟随目标机
        privateKey: ~/.ssh/id_ed25519
      # - host: 第二级跳板 ...
    # --- 连接与安全 ---
    readyTimeout: 20000        # 等价 ConnectTimeout（毫秒，默认 20s）
    keepaliveInterval: 0       # 等价 ServerAliveInterval（毫秒，0 禁用）
    keepaliveCountMax: 3       # 等价 ServerAliveCountMax
    strictHostKeyChecking: false   # true 时校验主机指纹
    knownHosts:                    # strictHostKeyChecking: true 时必填
      - 'SHA256:xxxxxxxx...'

- id: subprocess-ssh
  name: dsh-ssh/subprocess     # ctx.subprocess 远程 provider

- id: fs-ssh
  name: dsh-ssh/fs             # ctx.fs 远程 provider（SFTP）
```

## Config 字段参考（`dsh-ssh/ssh`）

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
| `readyTimeout` | number | 20000 | 连接超时（毫秒） |
| `keepaliveInterval` | number | 0 | SSH 层保活间隔（毫秒） |
| `keepaliveCountMax` | number | 3 | 保活失败判定次数 |
| `strictHostKeyChecking` | boolean | false | 是否校验主机指纹 |
| `knownHosts` | string[] | `[]` | 信任的主机指纹（`SHA256:…`）或原始 base64 公钥 |

### OpenSSH `~/.ssh/config` 映射

| OpenSSH 配置 | dsh-ssh 字段 |
|---|---|
| `HostName` / `Port` / `User` | `host` / `port` / `username` |
| `IdentityFile` / `IdentitiesOnly` | `privateKey`（路径或 PEM） |
| `PasswordAuthentication` | `password` |
| `ForwardAgent` | `agent` |
| `ProxyJump`（逗号分隔多级） | `jump` 数组（逐级） |
| `ConnectTimeout` | `readyTimeout` |
| `ServerAliveInterval` / `ServerAliveCountMax` | `keepaliveInterval` / `keepaliveCountMax` |
| `StrictHostKeyChecking` + `UserKnownHostsFile` | `strictHostKeyChecking` + `knownHosts` |
| `RemoteCommand` / `RequestTTY` | 见 `spawnTerminal`（PTY 由消费者请求） |

## 能力

| 能力 | 实现 |
|---|---|
| 跳板链 | `jump` 数组，多级跳板（direct-tcpip，等价 OpenSSH `ProxyJump`），每级独立认证 |
| 认证 | 密码、私钥（PEM 内容或路径）、passphrase、ssh-agent / Pageant |
| 近端上传 | SFTP 原子写（同目录临时文件 + rename，保留原 mode） |
| 远端下载 | fs provider 全套：read / streamText（流式解码）/ readBytes（限量）/ listDir / stat / lstat |
| 远程命令 | subprocess provider：collect（tail 保留 + 本地 spill 文件）、pipe、inherit、批量 stdin |
| 交互终端 | PTY（`spawnTerminal`），输入输出 + TERM→KILL 清理 |
| 环境隔离 | 远端登录环境 scrub（剔除 `DSH_*` 与凭据形变量）+ 显式 env 覆盖，`env -i` 启动 |
| 并发安全 | fs 写操作按 targetKey 串行化（防并发写同一文件） |
| 主机校验 | `strictHostKeyChecking` + `knownHosts`（SHA256 指纹或原始公钥） |

## 性能设计

- **连接复用**：三个 provider 共享一个 SSH 连接（含跳板链）；SFTP 通道懒打开、复用，断线自动失效重建。
- **环境缓存**：远程登录环境只读一次并缓存（`env -0` 一次开销），每次 spawn 不再重复探测。
- **输出本地 spill**：collect 模式的内存 tail + 本地 spill 文件，与官方本地 provider 同语义。
- **零额外往返**：spawn 一条 exec 通道完成命令（`cd && exec env -i -- …`），无轮询、无中间状态文件。

## 可靠性设计

- **退出事实权威**：exit code / signal 来自 SSH channel close 事件（真实远端进程事实）。
- **UTF-8 安全**：exec 输出整段 buffer 后统一解码，SSH 分包不会损坏多字节字符。
- **失败即报错**：连接失败、认证失败、跳板失败、SFTP 错误都 fail loud，携带可读信息。
- **清理兜底**：插件卸载时终止全部活动进程/终端并关闭连接；临时文件（staging dir、spill）随写失败清理。

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| `All configured authentication methods failed` | 认证配置错误：核对 username / privateKey 路径 / passphrase；私钥权限过宽（chmod 600） |
| `Cannot read private key` | `privateKey` 不是 PEM 内容且文件路径不存在 |
| 跳板连接超时 | 检查跳板 host/port 可达性、`readyTimeout`；跳板机的 User/认证单独核对 |
| `Host key verification failed` | `strictHostKeyChecking: true` 且 `knownHosts` 未含目标指纹；用 `ssh-keyscan` 获取后填入 |
| exec 返回 127 | 远程命令不存在；确认远程 PATH（scrubbed 环境保留远端 PATH） |
| 写文件报 `FS_NOT_OBSERVED` | 文件已存在且用了 `createIfAbsent`（防覆盖语义，非 bug） |

## 已知限制

- **远端 pid 不可见**：SSH channel 不暴露远端 pid，`SubprocessHandle.pid` 恒为 `-1`。
- **终止不保证进程树**：`terminate` 通过 channel 信号（SIGTERM → grace → SIGKILL）作用于远程直接进程，不保证覆盖其子进程树（与本地 provider 的进程组语义有差距，属 SSH 协议固有）。
- **终端前台进程组**：`inspectForeground` 返回 `undefined`，`signalForeground` 不可用（SSH channel 无法解析远端前台进程组）。
- **单连接不重连**：连接断开后需重启插件（不自动重连）。
- **`streamText` 文件必须为文本**：二进制文件抛 `FS_NOT_TEXT`（与官方 provider 一致）。

## 开发

```sh
npm i
npm run typecheck
```

## License

MIT
