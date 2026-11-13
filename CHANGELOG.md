# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## <small>0.4.4 (2026-11-13)</small>

* fix: resolve open issue reports and track the DSH 0.2.2 prerelease ([44d2912](https://github.com/UynajGI/dsh-ssh/commit/44d2912)), closes [#6](https://github.com/UynajGI/dsh-ssh/issues/6) [8/#9](https://github.com/UynajGI/dsh-ssh/issues/9) [#11](https://github.com/UynajGI/dsh-ssh/issues/11) [#12](https://github.com/UynajGI/dsh-ssh/issues/12)
* fix(fs): route registry placeholders by path (#10) ([542fe7f](https://github.com/UynajGI/dsh-ssh/commit/542fe7f)), closes [#10](https://github.com/UynajGI/dsh-ssh/issues/10) [#7](https://github.com/UynajGI/dsh-ssh/issues/7)
## 0.4.3 (2026-10-20)

### Features

* **client:** filter and keyboard-navigate the directory picker — toolbar filter for the current listing, roving focus across folder rows, an up-one-level button, and a labeled new-connection action ([814f294](https://github.com/UynajGI/dsh-ssh/commit/814f294))

### Bug Fixes

* **engines:** drop the `dsh` upper bound so the plugin manager accepts newer DSH hosts ([1e56063](https://github.com/UynajGI/dsh-ssh/commit/1e56063))

## 0.4.2 (2026-10-20)

### Documentation

* trim the READMEs around the dsh plugin install flow and show the add-workspace dialog as a rendered mock instead of prose ([caffe6a](https://github.com/UynajGI/dsh-ssh/commit/caffe6a))

## 0.4.1 (2026-10-20)

### Features

* **client:** keep the workspace picker usable through transport drops — retain cached connections, hosts, and listings; mark them as cached; pause network actions; and silently repull on a fresh connection generation instead of surfacing raw `Failed to fetch` errors ([c74e17c](https://github.com/UynajGI/dsh-ssh/commit/c74e17c))

## 0.4.0 (2026-10-20)

* ci: track DSH upstream and repair broken bumps with Qwen Code ([e3c357c](https://github.com/UynajGI/dsh-ssh/commit/e3c357c))
* feat: multi-connection SSH registry with remote workspace UI ([b819a71](https://github.com/UynajGI/dsh-ssh/commit/b819a71))
* feat: split-pane workspace flow driven by ~/.ssh/config ([0518cce](https://github.com/UynajGI/dsh-ssh/commit/0518cce))
* feat: support DSH 0.2.1-rc.2 ([bcf94e6](https://github.com/UynajGI/dsh-ssh/commit/bcf94e6))
* feat: working remote sessions over the dsh web host ([aeb68f8](https://github.com/UynajGI/dsh-ssh/commit/aeb68f8))
* chore: regenerate lockfile with npm 10 for CI parity ([9c344ef](https://github.com/UynajGI/dsh-ssh/commit/9c344ef))
* chore(release): v0.3.0-pre ([8ff7728](https://github.com/UynajGI/dsh-ssh/commit/8ff7728))
* fix(client): collapse stretched form fields and reorder sidebar ([d43e717](https://github.com/UynajGI/dsh-ssh/commit/d43e717))
