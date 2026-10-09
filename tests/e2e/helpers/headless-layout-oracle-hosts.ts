/**
 * The two headless `orca serve` hosts the layout oracle drives with no window: orcad (plain Node)
 * and Electron serve. Both keep their pairing port across restarts so paired clients reconnect,
 * and a headless runtime's saved profile is the runtime layout the oracle checks.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import { resolveBundledOrcadRuntime } from '../../../src/main/orcad/orcad-bundled-runtime'
import { runProcess } from '../../../src/shared/child-process/run-process'
import { NODE_RUNTIME_PIN } from '../../../src/shared/node-runtime-pin'
import type { WorkspaceSessionState } from '../../../src/shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { cleanupE2EDaemons } from './electron-process-shutdown'
import { launchHeadlessPairedRuntimeHost } from './headless-paired-runtime-host'
import { cliServeProfile, spawnUntilReady, type ReadyProcess } from './orca-serve-cli-host'
import { readPersistedProfileState } from './persisted-profile-state'
import { partitionsFromProfileRoot } from './workspace-layout-oracle-views'
import type { WorkspaceLayoutPartition } from './workspace-layout-oracle-model'

export type HeadlessHostKind = 'orcad' | 'electron'

export type HeadlessOracleHost = {
  kind: HeadlessHostKind
  userDataDir: string
  /** Scratch root for this host's profile and paired-client state. */
  scratch: string
  pairingUrl: string
  /** Run by `dispose`, after the host stops. */
  cleanups: (() => void)[]
  /** Stops serve and starts it again on the same profile and port; `cold` also kills the PTY daemon. */
  restart: (options?: { cold?: boolean }) => Promise<void>
  dispose: () => Promise<void>
}

const ORCAD_SLOT = path.resolve('out/orcad')
const PROFILE_REMOVAL = { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }

/** The pinned Node an unpackaged `out/orcad` runs on (its natives are built for it). */
export function orcadNodeExecutable(): string | null {
  if (!existsSync(path.join(ORCAD_SLOT, 'orcad.js'))) {
    return null
  }
  const packaged = resolveBundledOrcadRuntime(ORCAD_SLOT)
  if (packaged) {
    return packaged
  }
  const dir = `node-v${NODE_RUNTIME_PIN.version}-${process.platform}-${process.arch}`
  const bin =
    process.platform === 'win32'
      ? path.resolve('out/node-runtime-cache', dir, 'node.exe')
      : path.resolve('out/node-runtime-cache', dir, 'bin', 'node')
  return existsSync(bin) ? bin : null
}

async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve())
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a TCP listen on a host address reports an AddressInfo.
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

function parseOrcadReadiness(stdout: string): { pairingUrl: string; daemon: string } | null {
  const newline = stdout.indexOf('\n')
  if (newline === -1) {
    return null
  }
  const ready: unknown = JSON.parse(stdout.slice(0, newline))
  const pairing = ready && typeof ready === 'object' && 'pairing' in ready ? ready.pairing : null
  const url = pairing && typeof pairing === 'object' && 'url' in pairing ? pairing.url : null
  const health = ready && typeof ready === 'object' && 'health' in ready ? ready.health : null
  const daemon =
    health && typeof health === 'object' && 'terminalDaemon' in health
      ? JSON.stringify(health.terminalDaemon)
      : 'missing'
  return typeof url === 'string' ? { pairingUrl: url, daemon } : { pairingUrl: '', daemon }
}

type StartedHost = Omit<HeadlessOracleHost, 'cleanups'>

async function startOrcadHost(scratch: string, node: string): Promise<StartedHost> {
  const profile = cliServeProfile(scratch)
  const port = await reserveLoopbackPort()
  const env = { ...profile.env, ORCA_USER_DATA: profile.userDataDir }
  const launch = (): Promise<ReadyProcess<{ pairingUrl: string; daemon: string }>> =>
    spawnUntilReady({
      label: 'orcad serve',
      program: node,
      args: [
        path.join(ORCAD_SLOT, 'orcad.js'),
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--json'
      ],
      env,
      timeoutMs: 120_000,
      parseReady: parseOrcadReadiness
    })
  let serve: ReadyProcess<{ pairingUrl: string; daemon: string }> | null = await launch()
  if (!serve.ready.pairingUrl || !serve.ready.daemon.includes('"live"')) {
    await serve.stop()
    await cleanupE2EDaemons(profile.userDataDir)
    throw new Error(`orcad serve is not usable: ${serve.ready.daemon}\n${serve.stderr()}`)
  }
  return {
    kind: 'orcad',
    userDataDir: profile.userDataDir,
    scratch,
    pairingUrl: serve.ready.pairingUrl,
    restart: async ({ cold } = {}) => {
      // SIGTERM is orcad's graceful stop and leaves the PTY daemon running.
      await serve?.stop()
      serve = null
      if (cold) {
        await cleanupE2EDaemons(profile.userDataDir)
      }
      serve = await launch()
    },
    dispose: async () => {
      await serve?.stop()
      serve = null
      await cleanupE2EDaemons(profile.userDataDir)
      rmSync(scratch, PROFILE_REMOVAL)
    }
  }
}

async function startElectronHost(scratch: string): Promise<StartedHost> {
  const host = await launchHeadlessPairedRuntimeHost({
    pinnedServePort: true,
    userDataParent: scratch
  })
  return {
    kind: 'electron',
    userDataDir: host.userDataDir,
    scratch,
    pairingUrl: host.offer.pairingUrl,
    restart: ({ cold } = {}) =>
      host.restartServeProcess(
        cold ? { betweenProcesses: () => cleanupE2EDaemons(host.userDataDir) } : {}
      ),
    dispose: async () => {
      await host.dispose()
      rmSync(scratch, PROFILE_REMOVAL)
    }
  }
}

/** Unix sockets live in userData and macOS caps their path at 104 bytes; a short dir in $HOME fits. */
function profileParent(): string {
  const tmp = os.tmpdir()
  if (process.platform === 'win32' || tmp.length <= 32) {
    return tmp
  }
  const parent = path.join(os.homedir(), '.orca-lo')
  mkdirSync(parent, { recursive: true })
  return parent
}

export async function startHeadlessOracleHost(kind: HeadlessHostKind): Promise<HeadlessOracleHost> {
  const scratch = mkdtempSync(path.join(profileParent(), 'lo-'))
  try {
    const node = kind === 'orcad' ? orcadNodeExecutable() : null
    if (kind === 'orcad' && !node) {
      throw new Error('out/orcad or its pinned Node is missing (pnpm build:orcad)')
    }
    const started = node ? await startOrcadHost(scratch, node) : await startElectronHost(scratch)
    const cleanups: (() => void)[] = []
    return {
      ...started,
      cleanups,
      dispose: async () => {
        await started.dispose()
        cleanups.forEach((cleanup) => cleanup())
      }
    }
  } catch (error) {
    rmSync(scratch, PROFILE_REMOVAL)
    throw error
  }
}

/** The local CLI's client: reads the runtime's metadata file in the profile. */
export function cliClient(host: HeadlessOracleHost): RuntimeClient {
  return new RuntimeClient(host.userDataDir, 30_000, null, null)
}

/** A client paired over the host's WebSocket offer, with its own client-side state directory. */
export function pairedClient(host: HeadlessOracleHost, name: string): RuntimeClient {
  const dir = path.join(host.scratch, `client-${name}`)
  mkdirSync(dir, { recursive: true })
  return new RuntimeClient(dir, 30_000, host.pairingUrl, null)
}

/** The runtime's layout: a headless runtime has no window, so its saved session is the state. */
export function readHeadlessPartitions(userDataDir: string): WorkspaceLayoutPartition[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: committed profile documents are read verbatim; the oracle's rules judge their shape rather than a parser salvaging it.
  const root = readPersistedProfileState(userDataDir) as {
    workspaceSession?: WorkspaceSessionState
    workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
  }
  return partitionsFromProfileRoot(root)
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ program: 'git', args, cwd, timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

/** A one-commit git repo added to the runtime; resolves the id of its main worktree. */
export async function addRepoWorktree(
  host: HeadlessOracleHost,
  client: RuntimeClient
): Promise<string> {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'layout-oracle-repo-'))
  host.cleanups.push(() => rmSync(repoPath, PROFILE_REMOVAL))
  writeFileSync(path.join(repoPath, 'README.md'), 'layout oracle\n')
  await git(repoPath, ['init', '-q'])
  await git(repoPath, ['add', 'README.md'])
  await git(repoPath, [
    '-c',
    'user.name=Layout Oracle',
    '-c',
    'user.email=oracle@example.invalid',
    'commit',
    '-q',
    '-m',
    'init'
  ])
  const added = await client.call<{ repo: { id: string } }>('repo.add', {
    path: repoPath,
    kind: 'git'
  })
  const repoId = added.result.repo.id
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {
      repo: `id:${repoId}`
    })
    const worktreeId = listed.result.worktrees[0]?.id
    if (worktreeId) {
      return worktreeId
    }
    await new Promise((settle) => setTimeout(settle, 300))
  }
  throw new Error(`repo ${repoId} never listed a worktree`)
}
