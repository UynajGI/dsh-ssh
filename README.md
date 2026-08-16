# dsh-ssh

English | [中文](README.zh.md)

<p align="center">
  <img src="https://img.shields.io/npm/v/dsh-ssh" alt="npm version">
  <img src="https://img.shields.io/npm/l/dsh-ssh" alt="license">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="node version">
  <img src="https://img.shields.io/github/actions/workflow/status/UynajGI/dsh-ssh/ci.yml?label=CI" alt="CI status">
  <img src="https://img.shields.io/github/stars/UynajGI/dsh-ssh" alt="GitHub stars">
  <img src="https://img.shields.io/badge/dsh-plugin-2ea44f" alt="dsh-plugin">
</p>

**SSH remote-execution plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).** Moves Bash, file tools, PTY terminals, and LSP onto a remote host over a single SSH connection — with multi-hop ProxyJump chains, SFTP upload/download, and full auth coverage. Built on [ssh2](https://github.com/mscdex/ssh2).

> First (and as of 2026-08, only) SSH remote-development plugin in the dsh-plugin ecosystem. Verified end-to-end against a real two-hop jump environment with key auth.

## Architecture: local brain, remote hands

```
Your machine (deepseek-harness)                      Remote host
┌────────────────────────────────────┐    SSH    ┌──────────────────────┐
│ agent loop (orchestration, memory) │◄──────────►│ bash / command exec  │
│ LLM API calls (direct, no egress)  │   exec    │ filesystem (SFTP)    │
│ credentials / config / sessions    │   pty     │ PTY terminals        │
│ ctx.subprocess → dsh-ssh           │   sftp    │ LSP / git / builds   │
│ ctx.fs → dsh-ssh                   │           │                      │
└────────────────────────────────────┘           └──────────────────────┘
```

**The harness does not need to be installed remotely.** dsh-ssh implements remote providers for two of the harness's capability seams — `ctx.subprocess` (remote processes) and `ctx.fs` (remote files). Every tool built on those seams (bash, file tools, terminals, LSP, subagent processes) switches to the remote host with zero changes: the model thinks locally, commands run remotely, results stream back into the local model context.

## Install

```sh
npm i dsh-ssh
```

## Quick start (cordis.yml)

**One row mounts everything** — the shared connection owner plus both remote providers:

```yaml
- id: ssh-remote
  name: dsh-ssh
  config:
    host: server.example.com  # target host (required; a ~/.ssh/config alias like prod works too)
    port: 22
    username: root            # required
    privateKey: ~/.ssh/id_ed25519   # identity-file path, or PEM content
    # password: 'xxx'               # password auth (mutually usable with privateKey)
    # agent: 'pageant'              # Windows Pageant; Unix: SSH_AUTH_SOCK path
    cwd: /root/workspace           # remote working directory (required, absolute POSIX path)
    # --- ProxyJump chain (optional; first hop from local, last hop to target) ---
    jump:
      - host: bastion.example.com
        # port: 22             # defaults to the target's
        # username: ubuntu     # defaults to the target's
        privateKey: ~/.ssh/id_ed25519
      # - host: second-hop ...
    # --- Connection & security ---
    readyTimeout: 20000        # ~ ConnectTimeout (ms, default 20s)
    keepaliveInterval: 0       # ~ ServerAliveInterval (0 disables)
    keepaliveCountMax: 3       # ~ ServerAliveCountMax
    strictHostKeyChecking: false   # verify the host key when true
    knownHosts:                    # required when strictHostKeyChecking: true
      - 'SHA256:xxxxxxxx...'
```

The aggregate row is equivalent to three subpath rows — mount them separately only when a deployment composes providers individually:

```yaml
- id: ssh
  name: dsh-ssh/ssh            # ctx.ssh connection owner (config above)
- id: subprocess-ssh
  name: dsh-ssh/subprocess     # ctx.subprocess remote provider
- id: fs-ssh
  name: dsh-ssh/fs             # ctx.fs remote provider (SFTP)
```

## Add-workspace over SSH (Web GUI)

The Web surface's **Add workspace** flow (the conversation hero picker and the
sidebar workspace browser) is taken over by the dsh-ssh client UI, laid out as a
**connection sidebar beside a directory browser** (VS Code Remote Explorer
style): the sidebar lists `~/.ssh/config` hosts, saved connections, and the
local entry; the right pane browses whichever side is active. Local listing
rides the `ctx.directoryPicker` `browse` capability; connection management and
remote listing ride dsh-ssh's own `/dsh-ssh` RPC channel.

### `~/.ssh/config` hosts in the sidebar (`config.hosts`)

The「SSH 配置主机」sidebar section is driven by the `config.hosts` endpoint:
every opening **re-reads** the host machine's `~/.ssh/config` and lists its
**exact Host aliases** (wildcard patterns such as `*.example.com` stay hidden),
each with the resolved `user@host:port`, IdentityFile presence, and ProxyJump
presence:

- Clicking an alias resolves its full config (username, port, identity, jump
  chain), **registers it silently, and drops you straight into that host's
  directory browser** — no form (VS Code Remote-SSH style). Registered aliases
  get an「已添加」badge and simply switch on click.
- An alias without a `User` skips registration and opens a **prefilled form**
  (port / identity / jumps already filled); only the username is missing.
- An alias without an `IdentityFile` can be registered, but the connection
  fails at auth — the right pane translates `All configured authentication
  methods failed` into a readable hint with a「补全认证」button that opens the
  prefilled form.

The「新建连接」form is alias-first as well: type a `~/.ssh/config` alias and
blur or paste auto-resolves and prefills (the manual「识别 ssh 配置」button
remains the loud fallback); a successful resolve shows a one-line summary
(alias → user@host:port, identity path, jump chain) inside the form.

A patch layer's `name` is a match guard rather than a replacement, so the Web
bundle's `@deepseek-ai/dsh-host-directory-picker-auto` row must be **disabled
by id** (its dynamically mounted in-app picker disappears with it) and the SSH
backend inserted under its own id. In the Web profile
(`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
# Disable the boot-resolved picker (its dynamic entries go with it).
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true

- insert:
    - id: ssh-remote
      name: dsh-ssh
      config: { ...same config as the quick start... }

    # The local-directory browse backend for the client directoryFlow slots.
    - id: directory-picker-ssh
      name: dsh-ssh/picker
      config:
        maxEntries: 1000

    # The connection registry + /dsh-ssh RPC (persistence, ~/.ssh/config
    # awareness, remote directory browsing).
    - id: ssh-web-channel
      name: dsh-ssh/web
      config:
        maxEntries: 1000
```

Picking a remote directory creates a session directly:

```ts
ctx.sessions.create({ cwd: `ssh://${connectionId}${remotePath}` })
```

`ctx.subprocess` and `ctx.fs` recognize `ssh://<id>/<path>` cwds and route that
session's bash / file / terminal operations onto the registered connection's
directory. The `ssh://` spelling does not enter the DSH local workspace registry
(see「Known limitations」).

### Picker configuration (`dsh-ssh/picker`)

| Field | Type | Default | Description |
|---|---|---|---|
| `maxEntries` | number | 1000 | Complete-result bound for one listed level (hidden rows count; `truncated` flags a cut) |
| `remoteLabel` | string | — | Retained field: the client flow no longer uses a pinned entry; remote entries live in the left connection sidebar |

`dsh-ssh/picker` now serves only the `ctx.directoryPicker` `browse` backend
(local directories keep working on Windows hosts; POSIX absolute paths go to
the aggregate SSH connection). The client UI's remote connection list and
remote directory browsing ride the `dsh-ssh/web` RPC channel instead.

## Configuration reference (`dsh-ssh/ssh`)

| Field | Type | Default | Description |
|---|---|---|---|
| `host` | string | — | Target hostname or address (required) |
| `port` | number | 22 | Target SSH port |
| `username` | string | — | Remote login user (required) |
| `password` | string | — | Password auth |
| `privateKey` | string | — | PEM key content or local identity-file path |
| `passphrase` | string | — | Passphrase for an encrypted key |
| `agent` | string | — | ssh-agent socket path or `pageant` |
| `jump` | JumpConfig[] | `[]` | ProxyJump chain; per-hop port/user/auth overrides |
| `cwd` | string | — | Remote working directory (required, absolute POSIX path) |
| `readyTimeout` | number | 20000 | Connection timeout (ms) |
| `keepaliveInterval` | number | 0 | SSH keepalive interval (ms) |
| `keepaliveCountMax` | number | 3 | Keepalive failure threshold |
| `strictHostKeyChecking` | boolean | false | Verify the host key against `knownHosts` |
| `knownHosts` | string[] | `[]` | Trusted fingerprints (`SHA256:…`) or raw base64 public keys |

### OpenSSH `~/.ssh/config` mapping

| OpenSSH directive | dsh-ssh field |
|---|---|
| `HostName` / `Port` / `User` | `host` / `port` / `username` |
| `IdentityFile` / `IdentitiesOnly` | `privateKey` (path or PEM) |
| `PasswordAuthentication` | `password` |
| `ForwardAgent` | `agent` |
| `ProxyJump` (comma-separated hops) | `jump` array (per-hop) |
| `ConnectTimeout` | `readyTimeout` |
| `ServerAliveInterval` / `ServerAliveCountMax` | `keepaliveInterval` / `keepaliveCountMax` |
| `StrictHostKeyChecking` + `UserKnownHostsFile` | `strictHostKeyChecking` + `knownHosts` |
| `RemoteCommand` / `RequestTTY` | see `spawnTerminal` (PTY is consumer-requested) |

## Capabilities

| Capability | Implementation |
|---|---|
| ProxyJump chains | `jump` array, multi-hop (direct-tcpip, equivalent to OpenSSH `ProxyJump`), independent auth per hop |
| Auth | password, private key (PEM or path), passphrase, ssh-agent / Pageant |
| Upload (local → remote) | SFTP atomic write (same-dir temp file + rename, mode preserved) |
| Download (remote → local) | full fs provider: read / streamText (streaming decode) / readBytes (bounded) / listDir / stat / lstat |
| Remote commands | subprocess provider: collect (bounded tail + local spill file), pipe, inherit, batch stdin |
| Interactive terminals | PTY (`spawnTerminal`), I/O plus TERM→KILL cleanup |
| Add-workspace GUI | `dsh-ssh/picker`: the directory-picker seam's `browse` backend; the client UI is a connection sidebar (`~/.ssh/config` one-click hosts + saved connections + local) beside the directory browser |
| Environment isolation | remote login env scrubbed (`DSH_*` and credential-shaped names removed) + explicit overrides, launched via `env -i` |
| Concurrency safety | fs writes serialized per target key (no interleaved writes) |
| Host verification | `strictHostKeyChecking` + `knownHosts` (SHA256 fingerprints or raw keys) |

## Performance

- **Connection reuse** — all three providers share one SSH connection (jump chain included); the SFTP channel opens lazily, is reused, and rebuilds itself after disconnects.
- **Environment cache** — the remote login environment is read once per connection (`env -0`), not per spawn.
- **Local spill** — collect-mode output keeps an in-memory tail plus a local spill file, same semantics as the official local provider.
- **No polling** — one exec channel per command (`cd && exec env -i -- …`); no polling or intermediate state files.

## Reliability

- **Exit facts are authoritative** — exit code / signal come from the SSH channel close event.
- **UTF-8 safe** — exec output is buffered and decoded once; SSH chunking cannot corrupt multi-byte characters.
- **Fail loud** — connection, auth, jump, and SFTP failures surface with readable messages.
- **Teardown** — plugin disposal terminates active processes/terminals and closes the connection; staging dirs and spill files are cleaned on failure.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `All configured authentication methods failed` | Wrong auth config: check username / privateKey path / passphrase; key permissions too open (`chmod 600`) |
| `Cannot read private key` | `privateKey` is neither PEM content nor an existing file |
| Jump connection timeout | Check hop reachability and `readyTimeout`; verify the hop's user/auth independently |
| `Host key verification failed` | `strictHostKeyChecking: true` without a matching `knownHosts` entry; collect the fingerprint with `ssh-keyscan` |
| exec exits 127 | Remote command not found; check the remote PATH (the scrubbed env keeps it) |
| Write fails with `FS_NOT_OBSERVED` | File exists and `createIfAbsent` was used (overwrite protection, not a bug) |

## Known limitations

- **Remote pid invisible** — SSH channels do not expose the remote pid; `SubprocessHandle.pid` is always `-1`.
- **Termination is not tree-scoped** — `terminate` signals the remote direct process (SIGTERM → grace → SIGKILL); descendants are not guaranteed to die (inherent to the SSH protocol, unlike the local provider's process groups).
- **No foreground process group** — `inspectForeground` returns `undefined` and `signalForeground` throws (the SSH channel cannot resolve a remote foreground group).
- **No reconnection** — a dropped connection requires a plugin restart.
- **Picker is remote-only on POSIX hosts** — every absolute path is a remote path there, so the local filesystem cannot share the picker's vocabulary (Windows hosts keep both worlds via drive/UNC routing).
- **Text-only streaming** — `streamText` rejects binary files with `FS_NOT_TEXT` (same as the official provider).

## Development

```sh
npm i
npm run typecheck
npm run build       # emits lib/ — the compiled payload the harness loader imports
```

- **Git hooks** (husky): `pre-commit` typechecks; `commit-msg` enforces [Conventional Commits](https://www.conventionalcommits.org/); `pre-push` rejects a version tag that does not match `package.json`.
- **CI** (GitHub Actions): typecheck + publishable-payload check on every push/PR.
- **Release** (GitHub Actions): push a version tag to publish to npm and draft a GitHub Release:

```sh
npm version patch -m "chore(release): v%s"   # bumps package.json + commits + tags
git push origin main && git push origin --tags
```

The tag must match the `version` field in `package.json` (both hooks and the release workflow enforce it). Publishing uses the `NPM_TOKEN` repository secret (an npm **Automation token** — it bypasses 2FA for CI).

## License

MIT
