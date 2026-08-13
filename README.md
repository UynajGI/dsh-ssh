# dsh-ssh

**DeepSeek Harness 的 SSH 远程开发插件**。把 Bash / PTY / 文件工具 / LSP 整体切到远程主机，支持跳板链（ProxyJump）、SFTP 上传下载、远程 subprocess 与交互终端。基于 [ssh2](https://github.com/mscdex/ssh2)，一套配置覆盖 SSH config 里最常见的连接项。

> 协议说明：本插件是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 Cordis 插件。它实现两个能力缝隙（capability seam）的远程 provider —— `ctx.subprocess`（远程进程）与 `ctx.fs`（远程文件），因此 harness 里所有基于这两个缝隙的工具（bash、terminal、lsp、文件读写）无需任何改动即可切到远端执行。

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
    host: 10.0.0.5            # 目标主机
    port: 22
    username: root
    privateKey: ~/.ssh/id_ed25519   # 私钥文件路径，或直接写 PEM 内容
    # password: 'xxx'               # 密码认证
    # agent: 'pageant'              # Windows Pageant，或 SSH_AUTH_SOCK 路径
    cwd: /root/workspace           # 远程工作目录（必填，绝对路径）
    # --- 跳板链（可选，按序：先连第一个跳板，最后连目标）---
    jump:
      - host: 47.xx.xx.1
        username: ubuntu
        privateKey: ~/.ssh/id_ed25519
        # port: 22
      # - host: 第二级跳板 ...
    # --- 连接与安全 ---
    readyTimeout: 20000        # ConnectTimeout，默认 20s
    keepaliveInterval: 0       # ServerAliveInterval，0 禁用
    keepaliveCountMax: 3       # ServerAliveCountMax
    strictHostKeyChecking: false   # true 时校验主机指纹
    knownHosts:                # strictHostKeyChecking: true 时必填
      - 'SHA256:xxxxxxxx...'

- id: subprocess-ssh
  name: dsh-ssh/subprocess     # ctx.subprocess 远程 provider

- id: fs-ssh
  name: dsh-ssh/fs             # ctx.fs 远程 provider（SFTP）
```

配置完成后，`bash` / 文件读写 / 终端 / LSP 等工具的读写都发生在远程主机。

## 能力

| 能力 | 实现 |
|---|---|
| 跳板链 | `jump` 数组，多级跳板，等价 OpenSSH `ProxyJump`（direct-tcpip） |
| 认证 | 密码、私钥（PEM 内容或路径）、passphrase、ssh-agent / Pageant |
| 近端上传 | SFTP 原子写（临时文件 + rename） |
| 远端下载 | `fs` provider 的 read / streamText / listDir |
| 远程命令 | `subprocess` provider：stdout/stderr 收集（tail + spill）、pipe、inherit、批量 stdin |
| 交互终端 | PTY（`spawnTerminal`），支持输入输出与 TERM→KILL 清理 |
| 环境隔离 | 远端环境 scrub（去掉 `DSH_*` 与凭据形变量）+ 显式 env 覆盖，`env -i` 启动子进程 |
| 主机校验 | `strictHostKeyChecking` + `knownHosts`（SHA256 指纹或原始公钥） |
| 保活 | `keepaliveInterval` / `keepaliveCountMax` |

## 已知限制

- **远端 pid 不可见**：SSH channel 不暴露远端 pid，`SubprocessHandle.pid` 恒为 `-1`。
- **终止不保证进程树**：`terminate` 通过 channel 信号（SIGTERM → grace → SIGKILL）作用于远程直接进程，不保证覆盖其子进程树。
- **终端前台进程组**：`inspectForeground` 返回 `undefined`，`signalForeground` 不可用（SSH channel 无法解析远端前台进程组）。
- **单连接**：所有 provider 共享一个 SSH 连接，断线后需要重启（不自动重连）。

## 开发

```sh
npm i
npm run typecheck
```

## License

MIT
