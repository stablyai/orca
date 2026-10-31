import { afterEach, expect, vi } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import {
  LocalPtyProvider,
  _resetLocalPtyProviderStateForTest
} from '../../src/main/providers/local-pty-provider'
import { installPtyRuntimeController } from '../../src/main/ipc/pty/runtime/controller'
import { adoptStablePane } from '../../src/main/ipc/pty/pane/adopt-stable'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../src/main/ipc/pty/provider/registry'
import { finishPtyShutdown } from '../../src/main/ipc/pty/provider/liveness'
import {
  assertWorkspaceAcceptsNewPty,
  resolvePtySpawnStartupCwd
} from '../../src/main/ipc/pty/host-env/spawn-cwd'
import {
  noCodexResumeLaunch,
  prepareCodexResumeHome,
  resolveCodexResumeLaunch,
  reconcileSharedRuntimeResumeHome,
  stripSequencedStartupResumeArgv
} from '../../src/main/ipc/pty/host-env/codex-resume'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'
import type {
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../src/shared/agent-session-host-authority'
import type { PtyRuntimeControllerDeps } from '../../src/main/ipc/pty/runtime/controller-deps'
import type { ShellSpawnParams } from '../../src/main/providers/local-pty-utils'
import { SHELL_READY_MARKER_PREFIX } from '../../src/main/shell-ready-marker-scanner'
import * as startupStaging from '../../src/shared/startup-command-staging'
import { buildStartupCommandSubmission } from '../../src/shared/startup-command-submission'
import type * as PosixProcessTable from '../../src/main/pty/posix-pty-process-table'

const physical = vi.hoisted(() => ({ spawn: vi.fn(), sweep: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: physical.spawn }))
vi.mock('../../src/main/providers/local-pty-runtime-spawn', async () => {
  const { spawnShellWithFallback } = await import('../../src/main/providers/local-pty-utils')
  return {
    loadLocalPtyRuntimeSpawn: async () => (params: Omit<ShellSpawnParams, 'ptySpawn'>) =>
      spawnShellWithFallback({ ...params, ptySpawn: physical.spawn })
  }
})
vi.mock('../../src/main/pty-descendant-termination', () => ({
  killWithDescendantSweep: (...args: unknown[]) => physical.sweep(...args)
}))
vi.mock('../../src/main/pty/posix-pty-process-table', async (importOriginal) => ({
  ...(await importOriginal<typeof PosixProcessTable>()),
  readPosixPtyProcessTableSync: () => '',
  readPosixPtyProcessTable: async () => ''
}))

const previousProvider = getLocalPtyProvider()
afterEach(() => {
  _resetLocalPtyProviderStateForTest()
  setLocalPtyProvider(previousProvider)
  vi.unstubAllEnvs()
})

export async function retainedPrefillHost() {
  const { store } = await fixture()
  const root = store.getSettings().workspaceDir
  mkdirSync(root, { recursive: true })
  for (const key of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'ORCA_USER_DATA_PATH'
  ]) {
    const path = join(root, key.toLowerCase())
    mkdirSync(path, { recursive: true })
    vi.stubEnv(key, path)
  }
  vi.stubEnv('SHELL', '/bin/zsh')
  vi.stubEnv('ORCA_DISABLE_MACOS_LOGIN_SHELL', '1')
  store.updateSettings({
    agentLaunchChoices: {},
    agentPermissionDefault: 'ask',
    agentDefaultArgs: { claude: '' },
    agentDefaultEnv: { claude: {} }
  })
  const group = store.createProjectGroup({
    name: 'Fork',
    parentPath: root,
    createdFrom: 'folder-scan'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    name: 'Context fork',
    folderPath: root
  })
  const workspaceId = folderWorkspaceKey(folder.id)
  await store.flushPendingOrThrowAsync()
  const events: string[] = []
  const dataListeners = new Set<(data: string) => void>()
  let exit: ((event: { exitCode: number }) => void) | undefined
  const process = {
    pid: 3621019,
    process: 'zsh',
    onData: vi.fn((listener: (data: string) => void) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    }),
    onExit: vi.fn((listener: (event: { exitCode: number }) => void) => {
      exit = listener
      return {
        dispose: () => {
          exit = undefined
        }
      }
    }),
    write: vi.fn((data: string) => {
      events.push('startup-write')
      writes.push(data)
    }),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => {
      events.push('termination-failed')
      throw new Error('controlled physical termination failure')
    })
  }
  const writes: string[] = []
  physical.spawn.mockReset().mockImplementation(() => {
    events.push('physical-spawn')
    return process
  })
  physical.sweep
    .mockReset()
    .mockImplementation(async (_pid: number, signalRoot: () => void) => signalRoot())
  const provider = new LocalPtyProvider({
    getDefaultShell: () => '/bin/zsh',
    isHistoryEnabled: () => false
  })
  setLocalPtyProvider(provider)
  const runtime = new OrcaRuntimeService(store, undefined, { getLocalProvider: () => provider })
  const deps: PtyRuntimeControllerDeps = {
    runtime,
    store,
    getSettings: () => store.getSettings(),
    adoptStablePane: (args) => adoptStablePane(runtime, store, args),
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: (args) => prepareCodexResumeHome(undefined, args),
    noCodexResumeLaunch,
    resolveCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome,
    stripSequencedStartupResumeArgv,
    assertWorkspaceAcceptsNewPty: (...args) => assertWorkspaceAcceptsNewPty(store, ...args),
    resolvePtySpawnStartupCwd: (...args) => resolvePtySpawnStartupCwd(store, ...args),
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async (owner, id, options) => {
      await owner.shutdown(id, options)
      return true
    },
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map()
  }
  installPtyRuntimeController(deps)
  const compiler = await import('../../src/main/opencode/opencode-model-startup-plan')
  const compile = vi.spyOn(compiler, 'buildExecutionHostAgentStartupPlan')
  const binding = Promise.withResolvers<boolean>()
  void binding.promise.catch(() => {})
  const persist = vi.spyOn(store, 'persistPtyBinding').mockImplementation(async () => {
    events.push('binding-pending')
    return binding.promise
  })
  const create = vi.spyOn(runtime, 'createTerminal')
  const spawn = vi.spyOn(provider, 'spawn')
  const stage = vi.spyOn(startupStaging, 'stageStartupCommand')
  const calls: RuntimeCreateAgentSessionRequest[] = []
  const replies: RuntimeCreateAgentSessionResult[] = []
  const transport = vi.fn(
    async ({ method, params }: { method: string; params: RuntimeCreateAgentSessionRequest }) => {
      if (method === 'session.tabs.list') {
        events.push('post-create-list-failed')
        throw new Error('controlled post-create transport disconnect')
      }
      expect(method).toBe('terminal.createAgentSession')
      calls.push(params)
      events.push(`transport-${calls.length}`)
      try {
        const result = await runtime.createAgentSession(params, { clientId: 'paired-fork' })
        events.push('reclaimed')
        replies.push(result)
        return { ok: true, result }
      } catch (error) {
        events.push('host-failure-reply-lost')
        expect(calls).toHaveLength(1)
        expect(error).toMatchObject({ agentSessionOperationOutcome: 'unknown' })
        throw new Error('controlled lost transport reply')
      }
    }
  )
  return {
    store,
    workspaceId,
    root,
    process,
    provider,
    events,
    writes,
    calls,
    replies,
    transport,
    compile,
    create,
    spawn,
    persist,
    physicalSpawn: physical.spawn,
    releaseBinding() {
      binding.reject(new Error('controlled binding disk failure'))
    },
    async failBindingAfterHandoff(prompt: string) {
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
      expect(writes).toEqual([])
      // Real shell readiness and startup write execute while the actual disk await is held.
      const listeners = Array.from(dataListeners)
      for (const listener of listeners) {
        listener(`${SHELL_READY_MARKER_PREFIX}\x07$ `)
      }
      await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 3000 })
      expect(stage).toHaveBeenCalledOnce()
      const staged = stage.mock.results[0]?.value
      expect(staged?.delivery).toBe('staged')
      expect(staged?.scriptPath).toBeDefined()
      const command = stage.mock.calls[0]![0].command
      expect(command).toBe(spawn.mock.calls[0]?.[0].command)
      expect(command).toContain('--prefill')
      expect(command).toContain(prompt)
      expect(readFileSync(staged!.scriptPath!, 'utf8')).toContain(`${command}\n`)
      expect(writes[0]).toBe(
        buildStartupCommandSubmission(staged!.command, { bracketedPasteSafe: false })
      )
      events.push('binding-failed')
      binding.reject(new Error('controlled binding disk failure'))
    },
    exit() {
      exit?.({ exitCode: 0 })
    }
  }
}
