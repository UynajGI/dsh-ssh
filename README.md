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

**SSH remote-execution plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).** Moves Bash, file tools, PTY terminals, and LSP onto a remote host over a single SSH connection — multi-hop ProxyJump chains, SFTP upload/download, full auth coverage. Built on [ssh2](https://github.com/mscdex/ssh2).

## How it works

The harness stays local; only commands and files run remotely. dsh-ssh implements remote providers for two capability seams — `ctx.subprocess` (remote processes) and `ctx.fs` (remote files). Every tool built on them (bash, file tools, terminals, LSP, subagent processes) switches to the remote host with zero changes: the model thinks locally, commands run remotely, results stream back into the local context.

```
local  (deepseek-harness)          SSH          remote host
agent loop · LLM calls · sessions  ⇄ exec/pty/sftp ⇄  bash · files (SFTP) · PTY · LSP
```

## Install

Use DSH's plugin manager so the bundle is installed **and selected** in the profile:

- **Web UI**: open **Plugins** in the left sidebar → **Add plugin** → search `dsh-ssh` (or choose a local path, Git URL, or tarball).
- **CLI** (forwards to pnpm inside the profile):

  ```sh
  dsh plugin --profile web add dsh-ssh
  dsh plugin --profile web add link:/absolute/path/to/dsh-ssh   # local checkout (build first)
  dsh plugin --profile web why dsh-ssh
  dsh plugin --profile web remove dsh-ssh
  ```

Installing writes the profile's `package.json` and `dsh.profile.bundles` selection — no manual `cordis.yml` edit. HMR applies it immediately; without HMR, restart the profile. Selecting the bundle applies the package's [`cordis.patch.yml`](cordis.patch.yml): it mounts the SSH providers and the add-workspace picker and disables the default picker. Its `ssh-remote` row is a placeholder — create real connections in the Web **Add workspace** flow.

`package.json` declares `engines.dsh` (`>=0.2.0-rc.2 <0.3.0`); an incompatible DSH host is rejected before install.

A plain npm dependency (`npm i dsh-ssh`) does not select the bundle — add it to `dsh.profile.bundles` yourself.

## Requirements

- **DeepSeek Harness 0.2.x** — validated against `0.2.1-rc.2`.
- **Node.js ≥ 22**.
- An SSH endpoint reachable from the harness host; the remote side only needs a POSIX login shell and SFTP.

## Configure

**One row mounts everything** — the shared connection owner plus both remote providers:

```yaml
- id: ssh-remote
  name: dsh-ssh
  config:
    host: server.example.com  # target host or ~/.ssh/config alias
    port: 22
    username: root            # required
    privateKey: ~/.ssh/id_ed25519   # identity-file path or PEM content
    # password: 'xxx'               # password auth (may coexist with privateKey)
    # agent: 'pageant'              # Windows Pageant; Unix: SSH_AUTH_SOCK path
    cwd: /root/workspace           # remote working directory (required, absolute POSIX path)
    jump:                          # optional ProxyJump chain (first hop → target)
      - host: bastion.example.com
        privateKey: ~/.ssh/id_ed25519
    readyTimeout: 45000        # ~ ConnectTimeout (ms)
    strictHostKeyChecking: false   # verify the host key when true
```

The aggregate row is equivalent to three subpath rows, mount these separately only when composing providers individually: `dsh-ssh/ssh` (connection), `dsh-ssh/subprocess` (processes), `dsh-ssh/fs` (files).

### Config reference (`dsh-ssh/ssh`)

| Field | Type | Default | Description |
|---|---|---|---|
| `host` | string | — | Target hostname or address (required) |
| `port` | number | 22 | Target SSH port |
| `username` | string | — | Remote login user (required) |
| `password` | string | — | Password auth |
| `privateKey` | string | — | PEM key content or local identity-file path |
| `passphrase` | string | — | Passphrase for an encrypted key |
| `agent` | string | — | ssh-agent socket path or `pageant` |
| `jump` | JumpConfig[] | `[]` | ProxyJump chain, per-hop port/user/auth overrides |
| `cwd` | string | — | Remote working directory (required, absolute POSIX path) |
| `readyTimeout` | number | 45000 | Connection timeout (ms) |
| `keepaliveInterval` | number | 0 | SSH keepalive interval (ms, 0 disables) |
| `keepaliveCountMax` | number | 3 | Keepalive failure threshold |
| `strictHostKeyChecking` | boolean | false | Verify the host key against `knownHosts` |
| `knownHosts` | string[] | `[]` | Trusted `SHA256:…` fingerprints or raw base64 public keys |

### OpenSSH `~/.ssh/config` mapping

| OpenSSH directive | dsh-ssh field |
|---|---|
| `HostName` / `Port` / `User` | `host` / `port` / `username` |
| `IdentityFile` / `IdentitiesOnly` | `privateKey` |
| `PasswordAuthentication` | `password` |
| `ForwardAgent` | `agent` |
| `ProxyJump` (comma-separated hops) | `jump` array |
| `ConnectTimeout` | `readyTimeout` |
| `ServerAliveInterval` / `ServerAliveCountMax` | `keepaliveInterval` / `keepaliveCountMax` |
| `StrictHostKeyChecking` + `UserKnownHostsFile` | `strictHostKeyChecking` + `knownHosts` |

## Web profile: release the local `subprocess` / `fs` slots

`subprocess` and `fs` are **single-slot** services, and the stock web profile mounts local providers that own both. If they keep the slots, a remote session's commands and files silently run on the harness host (the `ssh` service still registers, so it looks fine). Release the slots in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
# Hand the slots to the dsh-ssh remote providers
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
  disabled: true
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true

# Windows hosts: the remote side is POSIX, so use bash, not pwsh.
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: false
- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  disabled: true
```

Local writes lose their sandbox fence (the approval stack is unaffected). This is a whole-swap design: one instance serves either local or remote workspaces, not both — run two profiles to use both worlds.

## Add-workspace over SSH (Web)

The Web **Add workspace** flow becomes a **connection sidebar beside a directory browser**: the sidebar lists `~/.ssh/config` hosts, saved connections, and the local entry; the right pane browses the active side. `~/.ssh/config` aliases are one-click — clicking one resolves its config, registers it, and drops you into that host's browser; an alias without a `User` opens a prefilled form instead. Picking a remote directory opens a session whose bash/file/terminal tools run on that connection (via a local placeholder cwd); remote sessions are not added to the DSH local workspace registry.

## Capabilities

| Capability | Implementation |
|---|---|
| ProxyJump chains | `jump` array, multi-hop (direct-tcpip, like OpenSSH `ProxyJump`), independent auth per hop |
| Auth | password, private key (PEM/path), passphrase, ssh-agent / Pageant; falls back to `~/.ssh` default identities |
| Write / read | atomic SFTP write (same-directory staging + rename, mode preserved); full fs provider (readText / streamText / readBytes / readByteRange / listDir / stat / lstat) |
| Remote commands | subprocess provider: collect (bounded tail + local spill file), pipe, inherit, batch stdin |
| Interactive terminals | PTY (`spawnTerminal`), I/O, `resize`, TERM→KILL cleanup |
| Environment isolation | remote login env scrubbed (`DSH_*` + credential-shaped names) + explicit overrides, launched via `env -i` |
| Concurrency / safety | fs writes serialized per target; host verification via `strictHostKeyChecking` + `knownHosts` |

Connection reuse: all three providers share one SSH connection (jump chain included); the SFTP channel opens lazily and is reused. The remote login environment is read once per connection, not per spawn. One exec channel per command — no polling.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `All configured authentication methods failed` | Wrong auth config: check username / privateKey path / passphrase; key permissions too open (`chmod 600`) |
| `Host key verification failed` | `strictHostKeyChecking: true` without a matching `knownHosts` entry; collect the fingerprint with `ssh-keyscan` |
| Jump connection timeout | Check hop reachability and `readyTimeout`; verify the hop's user/auth independently |
| `Cannot read private key` | `privateKey` is neither PEM content nor an existing file |
| exec exits 127 | Remote command not found; check the remote PATH |
| Write fails with `FS_NOT_OBSERVED` | File exists and `createIfAbsent` was used (overwrite protection, not a bug) |
| Remote commands/files run on the harness host | The single `subprocess` / `fs` slots are still local — see the Web profile slot release above |
| Plugin manager reports `not-a-bundle`, or a linked checkout has no `lib/` | Missing `dsh.bundle.patch` / `lib/`. Local checkout: `npm ci && npm run build`, then re-link |

## Known limitations

- **Remote pid invisible / no process tree** — `pid` is always `-1`; `terminate` signals the remote direct process only, descendants are not guaranteed to die.
- **No foreground group / activity** — `inspectForeground` is `undefined`, `signalForeground` throws, `inspectActivity` reports `unknown`.
- **No control pipe** — `SubprocessHandle.control` is `undefined`.
- **The SSH link does not reconnect** — a dropped SSH connection to the remote host keeps its cached `ready` promise and needs the connection recreated; a full DSH host restart may also require a page reload.
- **Remote directories land as sessions** — a remote session opens through a local placeholder cwd and is not recorded in the DSH local workspace registry.
- **Picker is remote-only on POSIX hosts** — every absolute path is remote there (Windows hosts keep both via drive/UNC routing).
- **Text-only streaming** — `streamText` rejects binary files with `FS_NOT_TEXT`.

## Development

```sh
npm i
npm run typecheck
npm run build       # emits lib/ — the compiled payload the harness loader imports
```

- **Layout**: `src/` is the node half (providers, registry, web channel); `src/client/` is the browser half.
- **Git hooks** (husky): `pre-commit` typechecks; `commit-msg` enforces [Conventional Commits](https://www.conventionalcommits.org/); `pre-push` rejects a version tag that does not match `package.json`.
- **CI**: typecheck + publishable-payload check on every push/PR.
- **Release**: push a `v*` tag to publish to npm and draft a GitHub Release (uses the `NPM_TOKEN` automation-token secret):

```sh
npm version patch -m "chore(release): v%s"
git push origin main && git push origin --tags
```

## License

MIT
