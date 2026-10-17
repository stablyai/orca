import { appendFileSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { expect } from '@stablyai/playwright-test'
import { getPiAgentStatusExtensionSource } from '../../../src/main/pi/agent-status-extension-source'
import type { AgentHookEndpoint } from '../../../src/shared/agent-hook-endpoint-file'
import { spawnProcess } from '@orca/process-host'
import { resolveExecutableCommand } from '../../../src/shared/node-cli-command-resolution'
import { deterministicProviderSource } from './omp-deterministic-provider'
import type { NativeObservation } from './omp-native-observation'

type RpcFrame = {
  type: string
  id?: string
  success?: boolean
  data?: { sessionFile?: string; isSettled?: boolean }
}

export type OmpStatusRuntime = {
  directory: string
  observations: () => NativeObservation[]
  command: (type: string, fields?: Record<string, unknown>) => Promise<RpcFrame>
  release: (name: string) => Promise<void>
  resetGates: () => Promise<void>
  stop: () => Promise<void>
}

/** Real installed SDK, isolated home and local deterministic model output. */
export async function startOmpStatusRuntime(options: {
  directory: string
  names: string[]
  endpoint: AgentHookEndpoint
  paneKey: string
  worktreeId: string
}): Promise<OmpStatusRuntime> {
  const { directory, endpoint } = options
  const home = path.join(directory, 'home')
  const agentDir = path.join(home, '.omp', 'agent')
  const workspace = path.join(directory, 'workspace')
  const sessions = path.join(directory, 'sessions')
  const gates = path.join(directory, 'gates')
  const gateNames = [...options.names, 'root-start', 'root-finish']
  const observationPath = path.join(directory, 'native-observations.json')
  const generated = path.join(directory, 'orca-agent-status.ts')
  const fixture = path.join(directory, 'deterministic-provider.ts')
  await Promise.all(
    [agentDir, sessions, gates, path.join(workspace, '.omp', 'agents')].map((folder) =>
      mkdir(folder, { recursive: true })
    )
  )
  await Promise.all([
    writeFile(path.join(gates, 'root-start'), ''),
    writeFile(observationPath, '[]'),
    writeFile(generated, getPiAgentStatusExtensionSource('omp')),
    writeFile(fixture, deterministicProviderSource),
    writeFile(
      path.join(agentDir, 'config.yml'),
      JSON.stringify({
        async: { enabled: true },
        task: {
          batch: true,
          structured: false,
          maxConcurrency: options.names.length,
          isolation: { enabled: false }
        },
        retry: { enabled: false, modelFallback: false },
        modelRoles: {
          default: 'orca-status-smoke/deterministic',
          task: 'orca-status-smoke/deterministic',
          smol: 'orca-status-smoke/label',
          tiny: 'orca-status-smoke/label'
        },
        approval: { mode: 'yolo' }
      })
    ),
    writeFile(
      path.join(workspace, '.omp', 'agents', 'status-smoke.md'),
      [
        '---',
        'name: status-smoke',
        'description: Deterministic native status test',
        'model: orca-status-smoke/deterministic',
        'thinkingLevel: off',
        'tools: [bash]',
        'spawns: []',
        '---',
        'Return the configured deterministic response.'
      ].join('\n')
    )
  ])
  // Do not inherit provider credentials or another pane's ownership.
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC'].includes(key.toUpperCase())
      )
    ),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: directory,
    PI_CODING_AGENT_DIR: agentDir,
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_PANE_KEY: options.paneKey,
    ORCA_TAB_ID: options.paneKey.split(':')[0],
    ORCA_WORKTREE_ID: options.worktreeId,
    ORCA_AGENT_HOOK_PORT: String(endpoint.port),
    ORCA_AGENT_HOOK_TOKEN: endpoint.token,
    ORCA_AGENT_HOOK_ENV: endpoint.env,
    ORCA_AGENT_HOOK_VERSION: endpoint.version,
    ORCA_OMP_SMOKE_OBSERVATIONS: observationPath,
    ORCA_OMP_SMOKE_GATES: gates,
    ORCA_OMP_SMOKE_NAMES: JSON.stringify(options.names)
  }
  const program = resolveExecutableCommand(process.env.ORCA_OMP_PROOF_BINARY ?? 'omp', {
    pathEnv: env.PATH ?? env.Path,
    homePath: home
  })
  if (!program) {
    throw new Error('Install OMP on PATH or set ORCA_OMP_PROOF_BINARY to its absolute executable')
  }
  const child = spawnProcess({
    program,
    args: [
      '--mode',
      'rpc',
      '--no-ui',
      '--no-title',
      '--no-extensions',
      '--extension',
      fixture,
      '--extension',
      generated,
      '--no-skills',
      '--no-rules',
      '--no-lsp',
      '--session-dir',
      sessions,
      '--model',
      'orca-status-smoke/deterministic',
      '--thinking',
      'off',
      '--tools',
      'task,wait',
      '--yolo'
    ],
    cwd: workspace,
    env,
    timeoutMs: null
  })
  let failure: Error | undefined
  let serial = 0
  const responses = new Map<string, RpcFrame>()
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>()
  for (const stream of [child, child.stdin, child.stdout, child.stderr]) {
    stream.on('error', (error) => {
      failure = error
    })
  }
  child.stderr.on('data', (chunk: Buffer) =>
    appendFileSync(path.join(directory, 'stderr.txt'), chunk)
  )
  child.once('close', () => {
    failure ??= new Error('Installed OMP exited before scenario completion')
    resolveClosed()
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const frame: RpcFrame = JSON.parse(line)
      if (frame.type === 'response' && frame.id) {
        responses.set(frame.id, frame)
      }
    } catch {
      // The CLI can emit startup diagnostics before RPC readiness.
    }
  })
  const observations = (): NativeObservation[] => JSON.parse(readFileSync(observationPath, 'utf8'))
  const assertRunning = () => {
    if (failure || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Installed OMP failed; see ${directory}`, { cause: failure })
    }
  }
  const stop = async () => {
    // Release real bash loops even when setup/assertions failed, before terminating their owner.
    await Promise.allSettled(gateNames.map((name) => writeFile(path.join(gates, name), '')))
    await expect
      .poll(
        () =>
          !observations()
            .findLast((row) => row.kind === 'registry')
            ?.refs?.some((ref) => ref.pendingAsync),
        { timeout: 5_000 }
      )
      .toBe(true)
      .catch(() => undefined)
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
      }
      await closed
    } finally {
      clearTimeout(timer)
      lines.close()
    }
  }
  const command = async (
    type: string,
    fields: Record<string, unknown> = {},
    timeout = 15_000
  ): Promise<RpcFrame> => {
    assertRunning()
    const id = `omp-status-${++serial}`
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`)
    await expect
      .poll(
        () => {
          assertRunning()
          return responses.has(id)
        },
        { timeout, message: `No OMP RPC response for ${type}; see ${directory}` }
      )
      .toBe(true)
    const response = responses.get(id)!
    responses.delete(id)
    if (!response.success) {
      throw new Error(`OMP RPC ${type} failed: ${JSON.stringify(response)}`)
    }
    return response
  }
  try {
    await command('get_state', {}, 30_000)
  } catch (error) {
    await stop()
    throw error
  }
  return {
    directory,
    observations: () => {
      assertRunning()
      return observations()
    },
    command,
    release: (name) => writeFile(path.join(gates, name), ''),
    resetGates: async () => {
      await Promise.all(gateNames.map((name) => rm(path.join(gates, name), { force: true })))
    },
    stop
  }
}
