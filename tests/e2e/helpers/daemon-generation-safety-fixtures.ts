import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DaemonPtyAdapter } from '../../../src/main/daemon/daemon-pty-adapter'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../../src/main/daemon/daemon-spawner'
import {
  recordProcessIdentity,
  recordProcessTree,
  terminateRecordedTree,
  waitForCondition,
  type RecordedProcessIdentity
} from './daemon-generation-processes'
import {
  createDaemonGenerationRuntime,
  type DaemonGenerationRuntime
} from './daemon-generation-runtime-fixture'
import { DAEMON_GENERATION_WORKTREE_ID } from '../fixtures/daemon-generation-fixture-contract'

const MAX_CAPTURED_CHARS = 32_768
export { createDaemonGenerationRuntime, type DaemonGenerationRuntime }

export type DaemonGeneration = {
  label: string
  protocolVersion: number
  child: ChildProcess
  identity: RecordedProcessIdentity
  socketPath: string
  tokenPath: string
  logPath: string
  startupLog(): string
  logEvents(): Record<string, unknown>[]
}

export type GenerationCanary = {
  generation: DaemonGeneration
  role: 'live' | 'stale-mirror'
  sessionId: string
  rootIdentity: RecordedProcessIdentity
  descendantIdentity: RecordedProcessIdentity
  treeIdentities: RecordedProcessIdentity[]
  adapter: DaemonPtyAdapter
  output(): string
}

function readLogEvents(logPath: string): Record<string, unknown>[] {
  if (!existsSync(logPath)) {
    return []
  }
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) {
        return []
      }
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

export async function launchDaemonGeneration(options: {
  runtime: DaemonGenerationRuntime
  label: string
  protocolVersion: number
  refuseDispose?: boolean
}): Promise<DaemonGeneration> {
  const { runtime, label, protocolVersion, refuseDispose = false } = options
  const socketPath = getDaemonSocketPath(runtime.daemonDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(runtime.daemonDir, protocolVersion)
  const logPath = path.join(runtime.rootDir, `${label}.daemon.log`)
  let startupLog = ''
  const child = fork(
    runtime.entryPath,
    [
      '--protocol',
      String(protocolVersion),
      '--socket',
      socketPath,
      '--token',
      tokenPath,
      '--log',
      logPath,
      '--refuse-dispose',
      String(refuseDispose)
    ],
    {
      cwd: runtime.userDataDir,
      execPath: runtime.electronPath,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: path.join(process.cwd(), 'node_modules'),
        ORCA_USER_DATA_PATH: runtime.userDataDir
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  )
  child.stderr?.on('data', (chunk: Buffer) => {
    startupLog = `${startupLog}${chunk.toString('utf8')}`.slice(-MAX_CAPTURED_CHARS)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} daemon startup timed out: ${startupLog}`)),
        15_000
      )
      const settle = (callback: () => void): void => {
        clearTimeout(timer)
        child.off('error', onError)
        child.off('exit', onExit)
        child.off('message', onMessage)
        callback()
      }
      const onError = (error: Error): void => settle(() => reject(error))
      const onExit = (code: number | null): void =>
        settle(() => reject(new Error(`${label} daemon exited with ${code}: ${startupLog}`)))
      const onMessage = (message: unknown): void => {
        if ((message as { type?: unknown })?.type === 'ready') {
          settle(resolve)
        }
      }
      child.once('error', onError)
      child.once('exit', onExit)
      child.on('message', onMessage)
    })
    if (!child.pid) {
      throw new Error(`${label} daemon did not expose a PID`)
    }
    const identity = await recordProcessIdentity(child.pid)
    child.disconnect()
    return {
      label,
      protocolVersion,
      child,
      identity,
      socketPath,
      tokenPath,
      logPath,
      startupLog: () => startupLog,
      logEvents: () => readLogEvents(logPath)
    }
  } catch (error) {
    if (child.pid) {
      try {
        await terminateRecordedTree(await recordProcessTree(await recordProcessIdentity(child.pid)))
      } catch {
        // Startup may have exited before its process identity could be recorded.
      }
    }
    throw error
  }
}

function canaryCommand(runtime: DaemonGenerationRuntime, label: string, nonce: string): string {
  const escapedPath = runtime.canaryPath.replaceAll('"', '\\"')
  return `node "${escapedPath}" ${label} ${nonce}`
}

export async function spawnGenerationCanary(options: {
  runtime: DaemonGenerationRuntime
  generation: DaemonGeneration
  role: GenerationCanary['role']
}): Promise<GenerationCanary> {
  const { runtime, generation, role } = options
  const label = `${generation.label}-${role}`
  const nonce = randomUUID()
  // Why: production daemon inventory infers ownership from the durable prefix;
  // keep the fixture on that path so live-host adjudication cannot degrade to unknown.
  const sessionId = `${DAEMON_GENERATION_WORKTREE_ID}@@orca-9749-${label}-${randomUUID().slice(0, 8)}`
  const adapter = new DaemonPtyAdapter({
    socketPath: generation.socketPath,
    tokenPath: generation.tokenPath,
    protocolVersion: generation.protocolVersion
  })
  let output = ''
  adapter.onData((event) => {
    if (event.id === sessionId) {
      output = `${output}${event.data}`.slice(-MAX_CAPTURED_CHARS)
    }
  })
  const result = await adapter.spawn({
    sessionId,
    isNewSession: true,
    cols: 100,
    rows: 30,
    cwd: runtime.rootDir,
    ...(process.platform === 'win32' ? { shellOverride: 'powershell.exe' } : {}),
    command: canaryCommand(runtime, label, nonce)
  })
  if (!result.pid) {
    throw new Error(`${label} canary did not expose its root PID`)
  }
  await waitForCondition(`${label} canary readiness`, () =>
    output.includes(`ORCA_GENERATION_CANARY_READY ${label} ${nonce}`)
  )
  const match = new RegExp(`ORCA_GENERATION_CANARY_READY ${label} ${nonce} (\\d+)`).exec(output)
  const descendantPid = Number(match?.[1])
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`${label} canary did not report its descendant PID`)
  }
  const rootIdentity = await recordProcessIdentity(result.pid)
  const descendantIdentity = await recordProcessIdentity(descendantPid)
  const treeIdentities = await recordProcessTree(rootIdentity)
  if (!treeIdentities.some((identity) => identity.pid === descendantIdentity.pid)) {
    throw new Error(`${label} descendant is outside its disposable PTY tree`)
  }
  return {
    generation,
    role,
    sessionId,
    rootIdentity,
    descendantIdentity,
    treeIdentities,
    adapter,
    output: () => output
  }
}

export async function pingGenerationCanary(canary: GenerationCanary, nonce: string): Promise<void> {
  const label = `${canary.generation.label}-${canary.role}`
  const expected = `ORCA_GENERATION_CANARY_ACK ${label} ${nonce}`
  canary.adapter.write(canary.sessionId, `PING ${label} ${nonce}\r`)
  await waitForCondition(`${label} canary reply`, () => canary.output().includes(expected))
}

export async function cleanupDaemonGenerationFixtures(options: {
  generations: readonly DaemonGeneration[]
  canaries: readonly GenerationCanary[]
}): Promise<void> {
  const identities = [
    ...options.generations.map((generation) => generation.identity),
    ...options.canaries.flatMap((canary) => canary.treeIdentities)
  ]
  for (const canary of options.canaries) {
    canary.adapter.dispose()
  }
  await terminateRecordedTree(identities)
}
