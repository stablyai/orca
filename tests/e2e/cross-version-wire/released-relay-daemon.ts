import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { build, type Plugin } from 'esbuild'
import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../../../src/main/ssh/ssh-channel-multiplexer'
import { openSshPtyConsumerSession } from '../../../src/main/ssh/ssh-pty-consumer-session'
import { toAppSshPtyId } from '../../../src/main/providers/ssh-pty-id'
import { RELAY_SENTINEL } from '../../../src/main/ssh/relay-protocol'
import type { ReleaseCheckout } from './release-checkout'

/**
 * A released relay, built from its own tagged sources and run as the real detached daemon, so a test
 * can leave live terminals in it exactly as a quit app does and reach them the way a later build must.
 */
export type ReleasedRelayInstall = {
  /** The version directory: `relay.js` plus the `.version` its handshake reads. */
  dir: string
  version: string
}

/** The release whose relay an upgraded host still runs. */
export const PREVIOUS_RELAY_REF = 'v1.4.218'

const SENTINEL = Buffer.from(RELAY_SENTINEL, 'utf-8')
const DROPPED_DEPENDENCY_NAMESPACE = 'dropped-release-dependency'

// Why: the release bundles against this build's install, which may no longer ship a package the
// release imported (e.g. @streamparser/json). Such imports become empty modules; the relay paths
// these tests drive never call into them.
const droppedReleaseDependencies: Plugin = {
  name: DROPPED_DEPENDENCY_NAMESPACE,
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === DROPPED_DEPENDENCY_NAMESPACE) {
        return undefined
      }
      const resolved = await pluginBuild.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: DROPPED_DEPENDENCY_NAMESPACE
      })
      return resolved.errors.length > 0
        ? { path: args.path, namespace: DROPPED_DEPENDENCY_NAMESPACE }
        : resolved
    })
    pluginBuild.onLoad({ filter: /.*/, namespace: DROPPED_DEPENDENCY_NAMESPACE }, () => ({
      contents: 'module.exports = {}',
      loader: 'js'
    }))
  }
}

export function runShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('sh', ['-c', command], { timeout: 20_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })
}

/**
 * Bundles the release's relay the way its own build did, then lays it out as a host install:
 * `<root>/relay-<version>/` holding `relay.js` and `.version`, with the socket inside it.
 */
export async function installReleasedRelay(
  checkout: ReleaseCheckout,
  root: string
): Promise<ReleasedRelayInstall> {
  // Why bundled inside the checkout: `node-pty` stays external and resolves from the repo install,
  // and node resolves modules from the bundle's real path, not the install's symlink.
  const bundleDir = join(checkout.root, '.relay-bundle')
  const version = `0.1.0+${checkout.label}-xv`
  if (!existsSync(join(bundleDir, 'relay.js'))) {
    await mkdir(bundleDir, { recursive: true })
    await build({
      entryPoints: [join(checkout.root, 'src', 'relay', 'relay.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: join(bundleDir, 'relay.js'),
      external: ['node-pty', '@parcel/watcher', 'electron'],
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [droppedReleaseDependencies],
      logLevel: 'error'
    })
  }
  await writeFile(join(bundleDir, '.version'), version)
  const dir = join(root, `relay-${version}`)
  await mkdir(dir, { recursive: true })
  await symlink(join(bundleDir, 'relay.js'), join(dir, 'relay.js'))
  await writeFile(join(dir, '.version'), version)
  return { dir, version }
}

/** Starts the detached daemon with the grace a shipped client launches it with. */
export async function startReleasedRelayDaemon(
  install: ReleasedRelayInstall,
  sockPath: string,
  env: NodeJS.ProcessEnv = {}
): Promise<ChildProcess> {
  const daemon = spawn(
    process.execPath,
    [
      'relay.js',
      '--detached',
      '--grace-time',
      '0',
      '--sock-path',
      sockPath,
      '--credential-file',
      `${sockPath}.credential`
    ],
    { cwd: install.dir, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } }
  )
  const deadline = Date.now() + 15_000
  while (!(await accepts(sockPath)) || !existsSync(`${sockPath}.credential`)) {
    if (Date.now() > deadline || daemon.exitCode !== null) {
      // Why: the caller never receives this child, so nothing else would kill it.
      daemon.kill('SIGKILL')
      throw new Error('released relay daemon did not start')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return daemon
}

export function accepts(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(sockPath)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/**
 * Runs a shell command the way an SSH exec channel would and hands back the relay stream after its
 * ready sentinel — the local stand-in for the bridge transport the client opens over SSH.
 */
export function openShellRelayTransport(command: string): Promise<MultiplexerTransport> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let pending: Buffer | null = Buffer.alloc(0)
    let ready = false
    const dataCallbacks: ((data: Buffer) => void)[] = []
    const closeCallbacks: (() => void)[] = []
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('close', () => {
      if (!ready) {
        reject(new Error(`relay bridge exited before ready: ${stderr.trim()}`))
        return
      }
      for (const callback of closeCallbacks) {
        callback()
      }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (ready) {
        for (const callback of dataCallbacks) {
          callback(chunk)
        }
        return
      }
      pending = Buffer.concat([pending ?? Buffer.alloc(0), chunk])
      const index = pending.indexOf(SENTINEL)
      if (index === -1) {
        return
      }
      ready = true
      const rest = pending.subarray(index + SENTINEL.length)
      pending = rest.length > 0 ? rest : null
      resolve({
        write: (data, onSettled) =>
          child.stdin.write(data, (error) =>
            onSettled?.(error ? { ok: false, error } : { ok: true })
          ),
        supportsWriteSettlement: true,
        onData: (callback) => {
          dataCallbacks.push(callback)
          if (pending) {
            const buffered = pending
            pending = null
            callback(buffered)
          }
        },
        onClose: (callback) => {
          closeCallbacks.push(callback)
        },
        close: () => {
          child.kill('SIGTERM')
        }
      })
    })
  })
}

/**
 * What a shipped app leaves behind on quit: its relay keeps one shell that echoes each line it
 * reads, and the app's owner claim lapses after its grace. Returns the shell's app PTY id.
 */
export async function leaveShellInReleasedRelay(
  install: ReleasedRelayInstall,
  sockPath: string,
  targetId: string
): Promise<string> {
  const bridge = `cd '${install.dir}' && '${process.execPath}' relay.js --connect --sock-path '${sockPath}' --credential-file '${sockPath}.credential'`
  const oldApp = new SshChannelMultiplexer(await openShellRelayTransport(bridge))
  await openSshPtyConsumerSession(oldApp, {
    clientInstanceId: `${install.version}-app`,
    expectedServerBuildId: install.version,
    outputFlowControl: { requestedWindowSu: 256 * 1024 }
  })
  const spawned: unknown = await oldApp.request('pty.spawn', { cols: 80, rows: 24 })
  if (
    !spawned ||
    typeof spawned !== 'object' ||
    !('id' in spawned) ||
    typeof spawned.id !== 'string'
  ) {
    throw new Error('released relay pty.spawn returned no id')
  }
  oldApp.notify('pty.data', {
    id: spawned.id,
    data: 'stty -echo; while read -r l; do [ "$l" = quit ] && exit 0; echo "GOT:$l"; done\n'
  })
  await new Promise((resolve) => setTimeout(resolve, 500))
  oldApp.dispose()
  return toAppSshPtyId(targetId, spawned.id)
}
