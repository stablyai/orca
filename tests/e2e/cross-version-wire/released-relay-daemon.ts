/**
 * A released relay, built from its own tagged sources and run as the real detached daemon, so a test
 * can leave live terminals in it exactly as a quit app does and reach them the way a later build must.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { build, type Plugin } from 'esbuild'
import { JSONC_PARSER_ESM_ALIAS } from '../../../config/build-plugins/jsonc-parser-esm'
import type { ReleaseCheckout } from './release-checkout'

export type ReleasedRelayInstall = {
  /** The version directory: `relay.js` plus the `.version` its handshake reads. */
  dir: string
  version: string
}

/** The last release whose desktop drove SSH terminals through a relay. */
export const PREVIOUS_RELAY_REF = 'v1.4.224'

const DROPPED_DEPENDENCY_NAMESPACE = 'dropped-release-dependency'

// Why: the release bundles against this build's install, which may no longer ship a package the
// release imported. Such imports become empty modules; the relay paths these tests drive never
// call into them.
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
  const { bundleDir, version } = await buildReleasedRelayBundle(checkout)
  const dir = join(root, `relay-${version}`)
  await mkdir(dir, { recursive: true })
  await symlink(join(bundleDir, 'relay.js'), join(dir, 'relay.js'))
  await writeFile(join(dir, '.version'), version)
  return { dir, version }
}

/** The release's `relay.js` (and its `.version`), bundled once per checkout. */
export async function buildReleasedRelayBundle(
  checkout: ReleaseCheckout
): Promise<{ bundleDir: string; version: string }> {
  // Why bundled inside the checkout: `node-pty` stays external and resolves from the repo install,
  // and node resolves modules from the bundle's real path, not the install's symlink.
  const bundleDir = join(checkout.root, '.relay-bundle')
  const version = `0.1.0+${checkout.label}-xv`
  if (!existsSync(join(bundleDir, 'relay.js'))) {
    await mkdir(bundleDir, { recursive: true })
    await build({
      entryPoints: [join(checkout.root, 'src', 'relay', 'relay.ts')],
      // As the release's own build-relay did: UMD relative requires can't survive a bundle.
      alias: JSONC_PARSER_ESM_ALIAS,
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
  return { bundleDir, version }
}

/** Starts the detached daemon with the "keep terminals forever" grace a 1.4.224 client used. */
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

/** The relay's own bridge command, as the shipped client and this build's bridge both run it. */
export function releasedRelayConnectCommand(
  install: ReleasedRelayInstall,
  sockPath: string
): string {
  return `cd '${install.dir}' && '${process.execPath}' relay.js --connect --sock-path '${sockPath}' --credential-file '${sockPath}.credential'`
}

export {
  connectAsReleasedApp,
  leaveShellInReleasedRelay,
  openShellRelayTransport
} from './released-relay-transport'
