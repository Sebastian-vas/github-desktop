import * as Path from 'path'
import * as Fs from 'fs'
import {
  access,
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  copyFile,
} from 'fs/promises'
import { spawn, execFile } from 'child_process'
import { app, autoUpdater, net, WebContents } from 'electron'
import * as ipcWebContents from './ipc-webcontents'
import {
  compareVersions,
  ForkUpdateCheck,
  ForkUpdateMethod,
  ForkUpdateResult,
  IForkUpdate,
  IForkUpdateAsset,
} from '../lib/fork-update'

/**
 * Updates this fork from the GitHub releases of its repository:
 *
 * - Windows: Squirrel (Electron's autoUpdater) with the release as the feed.
 * - macOS: downloads the zip and replaces the app bundle (the native updater
 *   would need an Apple signing certificate).
 * - Linux: replaces the AppImage, or installs the .deb/.rpm with pkexec
 *   (the system asks for the password).
 */

const releasesApi = `https://api.github.com/repos/${__UPDATE_REPOSITORY__}/releases/latest`

/** The update found by the last check, and where it was downloaded */
let pending: {
  readonly update: IForkUpdate
  readonly method: ForkUpdateMethod
  file: string | null
  ready: boolean
} | null = null

function execFileText(file: string, args: ReadonlyArray<string>) {
  return new Promise<{ code: number; stdout: string }>(resolve => {
    execFile(file, [...args], (error, stdout) => {
      resolve({
        code:
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout: String(stdout),
      })
    })
  })
}

/** How this installation can update itself */
export async function getUpdateMethod(): Promise<ForkUpdateMethod> {
  if (__WIN32__) {
    // Squirrel installs put Update.exe next to the app's folder.
    const updateExe = Path.resolve(
      Path.dirname(process.execPath),
      '..',
      'Update.exe'
    )
    try {
      await access(updateExe)
      return 'squirrel'
    } catch {
      return 'manual'
    }
  }
  if (__DARWIN__) {
    return process.execPath.includes('.app/Contents/MacOS/')
      ? 'mac-replace'
      : 'manual'
  }
  if (process.env.APPIMAGE) {
    return 'appimage'
  }
  if ((await execFileText('dpkg-query', ['-W', 'github-desktop'])).code === 0) {
    return 'deb'
  }
  if ((await execFileText('rpm', ['-q', 'github-desktop'])).code === 0) {
    return 'rpm'
  }
  return 'manual'
}

/** The release file this installation needs, if the release has it */
function pickAsset(
  update: IForkUpdate,
  method: ForkUpdateMethod
): IForkUpdateAsset | null {
  const arm = process.arch === 'arm64'
  const find = (test: (name: string) => boolean) =>
    update.assets.find(a => test(a.name.toLowerCase())) ?? null

  switch (method) {
    case 'mac-replace':
      return find(n => n === `githubdesktop-macos-${arm ? 'arm64' : 'x64'}.zip`)
    case 'appimage':
      return find(
        n => n.endsWith('.appimage') && n.includes(arm ? 'arm64' : 'x86_64')
      )
    case 'deb':
      return find(
        n => n.endsWith('.deb') && n.includes(arm ? 'arm64' : 'amd64')
      )
    case 'rpm':
      return find(
        n => n.endsWith('.rpm') && n.includes(arm ? 'aarch64' : 'x86_64')
      )
    case 'squirrel':
      return find(n => n === 'releases')
    case 'manual':
      return null
  }
}

/** Looks for a release newer than the running app */
export async function checkForForkUpdate(): Promise<ForkUpdateCheck> {
  const current = app.getVersion()
  let release: any
  try {
    const response = await net.fetch(releasesApi, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'GitHubDesktop-fork-updater',
      },
    })
    if (response.status === 404) {
      return { kind: 'up-to-date', current }
    }
    if (!response.ok) {
      return {
        kind: 'error',
        message: `GitHub answered ${response.status} when looking for updates.`,
      }
    }
    release = await response.json()
  } catch (e) {
    return {
      kind: 'error',
      message: `Could not look for updates: ${
        e instanceof Error ? e.message : e
      }`,
    }
  }

  const tag: string = release.tag_name ?? ''
  const version = tag.replace(/^v/i, '')
  if (version === '' || compareVersions(version, current) <= 0) {
    return { kind: 'up-to-date', current }
  }

  const update: IForkUpdate = {
    version,
    tag,
    name: release.name || tag,
    notes: release.body ?? '',
    publishedAt: release.published_at ?? '',
    htmlUrl:
      release.html_url ??
      `https://github.com/${__UPDATE_REPOSITORY__}/releases`,
    assets: (release.assets ?? []).map((a: any) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  }

  const method = await getUpdateMethod()
  if (method !== 'manual' && pickAsset(update, method) === null) {
    // The release exists but its files are still being built and uploaded
    // by the release workflow: try again on the next check.
    return { kind: 'up-to-date', current }
  }

  if (pending === null || pending.update.version !== update.version) {
    pending = { update, method, file: null, ready: false }
  }
  return { kind: 'available', update, current, method }
}

function downloadsFolder() {
  return Path.join(app.getPath('temp'), 'github-desktop-update')
}

/** Downloads a file, reporting progress (0 to 1) */
async function downloadFile(
  url: string,
  destination: string,
  onProgress: (fraction: number) => void
) {
  const response = await net.fetch(url, {
    headers: { 'User-Agent': 'GitHubDesktop-fork-updater' },
  })
  if (!response.ok || response.body === null) {
    throw new Error(`The download failed (${response.status}).`)
  }
  const total = parseInt(response.headers.get('content-length') ?? '0', 10)
  const partial = `${destination}.partial`
  const file = Fs.createWriteStream(partial)
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      received += value.length
      if (!file.write(Buffer.from(value))) {
        await new Promise(resolve => file.once('drain', resolve))
      }
      if (total > 0) {
        onProgress(received / total)
      }
    }
  } finally {
    await new Promise<void>(resolve => file.end(() => resolve()))
  }
  await rename(partial, destination)
}

function squirrelDownload(
  update: IForkUpdate,
  onProgress: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      autoUpdater.removeListener('update-downloaded', onDownloaded)
      autoUpdater.removeListener('error', onError)
      autoUpdater.removeListener('update-not-available', onNotAvailable)
    }
    const onDownloaded = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onNotAvailable = () => {
      cleanup()
      reject(new Error('The release has no update package for Windows.'))
    }
    autoUpdater.on('update-downloaded', onDownloaded)
    autoUpdater.on('error', onError)
    autoUpdater.on('update-not-available', onNotAvailable)
    onProgress(0.05)
    autoUpdater.setFeedURL({
      url: `https://github.com/${__UPDATE_REPOSITORY__}/releases/download/${update.tag}`,
    })
    autoUpdater.checkForUpdates()
  })
}

/**
 * Downloads the update found by the last check, streaming the progress to
 * the renderer.
 */
export async function downloadForkUpdate(
  sender: WebContents
): Promise<ForkUpdateResult> {
  if (pending === null) {
    return { kind: 'error', message: 'There is no update to download.' }
  }
  if (pending.ready) {
    return { kind: 'success' }
  }
  const current = pending
  const progress = (fraction: number) => {
    if (!sender.isDestroyed()) {
      ipcWebContents.send(sender, 'fork-update-progress', Math.min(1, fraction))
    }
  }

  try {
    if (current.method === 'squirrel') {
      await squirrelDownload(current.update, progress)
    } else if (current.method !== 'manual') {
      const asset = pickAsset(current.update, current.method)
      if (asset === null) {
        throw new Error('The release has no file for this system.')
      }
      const folder = downloadsFolder()
      await rm(folder, { recursive: true, force: true })
      await mkdir(folder, { recursive: true })
      const destination = Path.join(folder, asset.name)
      await downloadFile(asset.url, destination, progress)
      current.file = destination
    }
    current.ready = true
    progress(1)
    return { kind: 'success' }
  } catch (e) {
    log.error('Fork updater: download failed', e)
    return {
      kind: 'error',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

/** Waits for a child process, resolving its exit code */
function waitFor(command: string, args: ReadonlyArray<string>) {
  return new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(command, [...args])
    let output = ''
    child.stdout?.on('data', d => (output += d))
    child.stderr?.on('data', d => (output += d))
    child.on('error', e => resolve({ code: -1, output: e.message }))
    child.on('close', code => resolve({ code, output }))
  })
}

async function installOnMac(zip: string) {
  // .../GitHub Desktop.app/Contents/MacOS/GitHub Desktop → the .app bundle
  const bundle = Path.resolve(Path.dirname(process.execPath), '..', '..')
  const extractTo = Path.join(Path.dirname(zip), 'extracted')
  await rm(extractTo, { recursive: true, force: true })
  const unzip = await waitFor('/usr/bin/ditto', ['-x', '-k', zip, extractTo])
  if (unzip.code !== 0) {
    throw new Error(`Could not unpack the update: ${unzip.output}`)
  }
  const newApp = (await readdir(extractTo)).find(n => n.endsWith('.app'))
  if (newApp === undefined) {
    throw new Error('The update does not contain the app.')
  }

  // Swap the bundles once this process has exited, then reopen the app. If
  // anything fails, the old bundle is put back.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const script = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf ${q(`${bundle}.old`)}`,
    `if mv ${q(bundle)} ${q(`${bundle}.old`)} && /usr/bin/ditto ${q(
      Path.join(extractTo, newApp)
    )} ${q(bundle)}; then`,
    `  /usr/bin/xattr -cr ${q(bundle)}; rm -rf ${q(`${bundle}.old`)}`,
    `else`,
    `  rm -rf ${q(bundle)}; mv ${q(`${bundle}.old`)} ${q(bundle)}`,
    `fi`,
    `open ${q(bundle)}`,
  ].join('\n')
  spawn('/bin/bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  }).unref()
  app.quit()
}

async function installAppImage(file: string) {
  const target = process.env.APPIMAGE
  if (target === undefined) {
    throw new Error('The AppImage location is unknown.')
  }
  const staged = `${target}.new`
  await copyFile(file, staged)
  await chmod(staged, 0o755)
  await rename(staged, target)
  spawn(target, [], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

async function installPackage(file: string, method: 'deb' | 'rpm') {
  // pkexec shows the system's password dialog.
  const args =
    method === 'deb'
      ? ['apt-get', 'install', '-y', '--allow-downgrades', file]
      : ['dnf', 'install', '-y', file]
  const result = await waitFor('pkexec', args)
  if (result.code === 126 || result.code === 127) {
    throw new Error('The installation was cancelled (no password given).')
  }
  if (result.code !== 0) {
    throw new Error(
      `The installation failed: ${result.output
        .trim()
        .split('\n')
        .slice(-6)
        .join('\n')}`
    )
  }
  app.relaunch()
  app.exit(0)
}

/** Installs the downloaded update and restarts the app */
export async function installForkUpdate(): Promise<ForkUpdateResult> {
  if (pending === null || !pending.ready) {
    return { kind: 'error', message: 'The update has not been downloaded yet.' }
  }
  try {
    switch (pending.method) {
      case 'squirrel':
        autoUpdater.quitAndInstall()
        break
      case 'mac-replace':
        await installOnMac(pending.file!)
        break
      case 'appimage':
        await installAppImage(pending.file!)
        break
      case 'deb':
      case 'rpm':
        await installPackage(pending.file!, pending.method)
        break
      case 'manual':
        return {
          kind: 'error',
          message:
            'This installation cannot update itself. Download it from the release page.',
        }
    }
    return { kind: 'success' }
  } catch (e) {
    log.error('Fork updater: install failed', e)
    return {
      kind: 'error',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}
