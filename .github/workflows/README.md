# Releasing

`release.yml` builds Delight for Windows x64 (portable exe) and Linux x64 (.deb
+ AppImage) and attaches the binaries to a GitHub Release. Assets live on the Release, not in git, so clones stay small (the whole
history is a couple of MB; one build of the exe is ~12 MB and git would keep
every copy forever).

## One-time setup: the BUFFERS_TOKEN secret

Delight's frontend re-exports the shared editor and language registry from the
Buffers repo — `src/langs.ts` and `src/editor-core.ts` are shims pointing at
`../../Buffers/src/…`. So a build needs **both** repos checked out side by side:

```
<workspace>/
  delight/   <- this repo
  Buffers/   <- mtrencseni/buffers
```

Buffers is private, and a workflow's built-in `GITHUB_TOKEN` only grants access
to the repo it runs in. The second checkout therefore needs a personal access
token:

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate
2. Repository access: **only `mtrencseni/buffers`**
3. Permissions: **Contents → Read-only** (nothing else)
4. Copy the token, then in the **delight** repo: Settings → Secrets and variables
   → Actions → New repository secret, named **`BUFFERS_TOKEN`**

Fine-grained tokens expire; when the workflow starts failing at the Buffers
checkout, regenerate and update the secret.

## Cutting a release

The tag must match `version` in `src-tauri/tauri.conf.json`, or the workflow
fails on purpose — a mismatch would ship a binary that reports the wrong version.

```bash
# bump src-tauri/tauri.conf.json first if needed, then:
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds, then creates a **draft** release with generated notes.
Review it on the Releases page and hit Publish.

Assets:

- `Delight-<version>-win_x64-portable.exe` — standalone; needs the WebView2
  runtime, which ships with Windows 11
- `…​.sha256` — checksum

## Dry runs

Actions tab → Release → **Run workflow**. It builds and uploads the exe as a
workflow artifact without creating a release, which is the cheap way to check a
change didn't break the build.

## Adding platforms later

- **Windows ARM64** — add `aarch64-pc-windows-msvc` to the toolchain targets and
  a second `--target` build. The hosted runner has the toolset; a local machine
  needs the "MSVC v143 – ARM64 build tools" component.
- **macOS** — add a `macos-latest` job. It cannot be cross-compiled from Windows;
  `.app`/`.dmg` bundling requires a Mac. Signing/notarization needs certificates
  in secrets, otherwise the build is unsigned.
- **Installer** — drop `--no-bundle` to get the NSIS `-setup.exe` back, and add
  it to `files:` with a `-setup` kind in the name.
