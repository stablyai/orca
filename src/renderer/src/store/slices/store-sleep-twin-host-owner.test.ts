import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

// The audit's case: one repo id + path published by both an SSH host and a managed runtime.
function seedTwin(store: ReturnType<typeof createTestStore>, ptyIds: string[]): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1', hostId: 'ssh:ssh-1' }),
        makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' }, 'runtime-1')
      ]
    },
    tabsByWorktree: {
      [WT]: [makeTab({ id: 'tab-1', worktreeId: WT, title: 'Codex', ptyId: ptyIds[0] ?? null })]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: ptyIds[0] ? { [LEAF]: ptyIds[0] } : {}
      }
    },
    ptyIdsByTabId: { 'tab-1': ptyIds }
  })
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { state: 'done', prompt: 'resume target', agentType: 'codex' },
      'Codex',
      { updatedAt: 2000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: WT },
      { providerSession: { key: 'session_id', id: 'target-session' } }
    )
}

function isRuntimeCall(value: unknown): value is { selector: string; method: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'selector' in value &&
    typeof value.selector === 'string' &&
    'method' in value &&
    typeof value.method === 'string'
  )
}

function runtimeCallsFor(method: string): { selector: string }[] {
  return mockApi.runtimeEnvironments.call.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(isRuntimeCall)
    .filter((args) => args.method === method)
}

describe('sleeping a worktree published by an SSH host and a runtime twin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('sends the sleep to the runtime the PTY names, and clears bindings only after it succeeds', async () => {
    const store = createTestStore()
    seedTwin(store, ['remote:runtime-1@@pty-1'])
    let releaseSleep: () => void = () => {}
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
    let bindingsDuringSleep: string[] | undefined
    mockApi.runtimeEnvironments.call.mockImplementation(async (args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return compatible
      }
      if (args.method === 'terminal.sleep') {
        bindingsDuringSleep = store.getState().ptyIdsByTabId['tab-1']
        await sleepGate
        return {
          id: 'rpc',
          ok: true,
          result: { stopped: 1, stoppedPtyIds: ['pty-1'], livePtyIds: [], postStopVerified: true },
          _meta: { runtimeId: 'remote-runtime' }
        }
      }
      return { id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'remote-runtime' } }
    })

    const sleeping = store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })
    await vi.waitFor(() => expect(bindingsDuringSleep).toBeDefined())
    expect(bindingsDuringSleep).toEqual(['remote:runtime-1@@pty-1'])
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.origin).toBe('live')
    releaseSleep()
    await sleeping

    expect(runtimeCallsFor('terminal.sleep').map((args) => args.selector)).toEqual(['runtime-1'])
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.origin).toBe('worktree-sleep')
  })

  it('keeps bindings and writes no resume record when the runtime sleep fails', async () => {
    const store = createTestStore()
    seedTwin(store, ['remote:runtime-1@@pty-1'])
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      return args.method === 'terminal.sleep'
        ? Promise.reject(new Error('runtime unreachable'))
        : Promise.resolve({ id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'r' } })
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })
    ).rejects.toThrow('runtime unreachable')

    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['remote:runtime-1@@pty-1'])
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.origin).toBe('live')
  })

  it('kills an SSH PTY through its own host and asks no runtime', async () => {
    const store = createTestStore()
    seedTwin(store, ['ssh:ssh-1@@pty-1'])

    await store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })

    expect(runtimeCallsFor('terminal.sleep')).toEqual([])
    expect(mockApi.pty.kill).toHaveBeenCalledWith('ssh:ssh-1@@pty-1', { keepHistory: true })
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
  })

  it.each([
    ['a remote PTY that names no runtime', ['remote:pty-1']],
    ['no bound PTY at all', []],
    ['PTYs split across two runtimes', ['remote:runtime-1@@pty-1', 'remote:runtime-2@@pty-2']]
  ])('refuses, leaving bindings and resume records untouched, for %s', async (_label, ptyIds) => {
    const store = createTestStore()
    seedTwin(store, ptyIds)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })
    ).rejects.toThrow('ambiguous_terminal_owner')

    expect(runtimeCallsFor('terminal.sleep')).toEqual([])
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(ptyIds)
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.origin).toBe('live')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('hibernating a completed agent pane in a twin-published worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    shutdownBufferCaptures.clear()
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
  })

  it('stops the pane on the runtime its PTY names', async () => {
    const store = createTestStore()
    seedTwin(store, ['remote:runtime-1@@pty-1'])

    await store.getState().shutdownCompletedAgentPaneForHibernation(WT, {
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'remote:runtime-1@@pty-1',
      expectedRuntimePtyId: 'pty-1'
    })

    expect(runtimeCallsFor('terminal.stopExact').map((args) => args.selector)).toEqual([
      'runtime-1'
    ])
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.origin).toBe('worktree-sleep')
  })

  it.each([
    ['a remote PTY with no host stop to run', 'remote:runtime-1@@pty-1', undefined],
    ['a remote PTY that names no runtime', 'remote:pty-1', 'pty-1']
  ])('refuses %s without touching bindings', async (_label, ptyId, expectedRuntimePtyId) => {
    const store = createTestStore()
    seedTwin(store, [ptyId])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(WT, {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        leafId: LEAF,
        ptyId,
        ...(expectedRuntimePtyId ? { expectedRuntimePtyId } : {})
      })
    ).rejects.toThrow('ambiguous_terminal_owner')

    expect(runtimeCallsFor('terminal.stopExact')).toEqual([])
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([ptyId])
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.origin).toBe('live')
    warn.mockRestore()
  })
})
