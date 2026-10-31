import { useAppStore } from '@/store'
// @vitest-environment happy-dom

import type * as LaunchErrors from '@/lib/structured-agent-session-launch-errors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

type CallParams = {
  envelope?: { expectedRuntimeFence?: number | null }
  key?: string
  value?: string
}

const mocks = vi.hoisted(() => ({
  settingsWrite: vi.fn(async () => {}),
  call: vi.fn<(target: unknown, method: string, params: CallParams) => Promise<unknown>>(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  launch: vi.fn()
}))

vi.mock('@/components/native-chat/native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.settingsWrite
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return { StructuredAgentSessionCreateRefusalError }
})

vi.mock('@/lib/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>('@/lib/structured-agent-session-launch-errors')),
  ...launchErrorMocks
}))

vi.mock('@/lib/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mocks.launch
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: vi.fn(),
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError:
      launchErrorMocks.StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      runtimeEnvironmentCatalogHydrated: true,
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => {}
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  applyStructuredLaunchHeldOptions,
  getStructuredAgentSessionLaunchSelection,
  holdStructuredAgentSessionLaunchOption
} from './structured-agent-session-launch-options'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests,
  subscribeStructuredAgentLaunchStatus
} from './agent-session/launch/structured-agent-session-launch-registry'
import { markStructuredAgentSessionLaunchPublished } from './agent-session/launch/structured-agent-session-launch-publication'
import {
  registerStructuredSelectionCatalogStore,
  structuredSessionSelectionController,
  forgetStructuredSessionSelection
} from './structured-agent-session-selection-controller'

const WORKTREE_ID = 'wt-1'
const SESSION_ID = 'session-1'

function launchIntent(seedOptions?: Record<string, string>): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId: WORKTREE_ID,
    executionHostId: 'local',
    target: { kind: 'local' },
    sessionId: SESSION_ID,
    agent: 'codex',
    params: {
      envelope: {
        sessionId: SESSION_ID,
        clientOperationId: 'operation-1',
        expectedRuntimeFence: null,
        payloadFingerprint: 'fingerprint-1'
      },
      worktree: `id:${WORKTREE_ID}`,
      agent: 'codex'
    },
    ...(seedOptions ? { seedOptions } : {})
  }
}

const PUBLISHED: RuntimeMobileSessionTabsResult = {
  worktree: WORKTREE_ID,
  publicationEpoch: 'epoch-1',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: [
    {
      type: 'agent-session',
      id: 'tab-1',
      title: 'Codex',
      sessionId: SESSION_ID,
      agent: 'codex',
      isActive: true
    }
  ]
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

const ACCEPTED = { ok: true, value: { key: 'model', value: 'x' } }

function mutations(): { method: string; fence?: unknown; key?: unknown; value?: unknown }[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.setOption' || method === 'agentSession.send')
    .map(([, method, params]) =>
      method === 'agentSession.setOption'
        ? {
            method,
            fence: params.envelope?.expectedRuntimeFence,
            key: params.key,
            value: params.value
          }
        : { method }
    )
}

function lifecycle() {
  return getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, SESSION_ID)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

let restoreCatalogStore: (() => void) | undefined
afterEach(() => {
  resetStructuredAgentLaunchRegistryForTests()
  forgetStructuredSessionSelection(SESSION_ID)
  restoreCatalogStore?.()
})
describe('picks made while a chat launches', () => {
  let setOptionReplies: Deferred<unknown>[]

  beforeEach(() => {
    restoreCatalogStore = registerStructuredSelectionCatalogStore({
      read: useAppStore.getState,
      subscribe: useAppStore.subscribe
    })
    forgetStructuredSessionSelection(SESSION_ID)
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    setOptionReplies = []
    mocks.createIntent.mockReturnValue(launchIntent({ model: 'gpt-seeded' }))
    mocks.retryIntent.mockImplementation((intent: StructuredAgentSessionLaunchIntent) => ({
      ...intent,
      seedOptions: { model: 'gpt-saved-since' }
    }))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([PUBLISHED])
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.setOption') {
        const reply = deferred<unknown>()
        setOptionReplies.push(reply)
        return reply.promise
      }
      if (method === 'agentSession.send') {
        return Promise.resolve({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
      }
      return new Promise(() => {})
    })
  })

  it('applies them against the receipt fence before the first turn and before publishing', async () => {
    const created = deferred<{ sessionId: string; fence: number }>()
    mocks.launch.mockReturnValue(created.promise)
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-1',
      prompt: 'first turn'
    })

    const modelPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
    created.resolve({ sessionId: SESSION_ID, fence: 7 })
    await settle()

    // The host published the tab, but the launch is not published until its picks land.
    markStructuredAgentSessionLaunchPublished(WORKTREE_ID, SESSION_ID, 'local')
    expect(lifecycle()).toBe('pending')
    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 7, key: 'model', value: 'gpt-picked' },
      { method: 'agentSession.setOption', fence: 7, key: 'effort', value: 'high' }
    ])
    setOptionReplies[0]!.resolve({
      ok: true,
      value: { key: 'model', value: 'gpt-picked', options: { model: 'gpt-picked' } }
    })
    await expect(modelPick).resolves.toEqual({
      kind: 'accepted',
      options: { model: 'gpt-picked' }
    })
    await settle()
    expect(lifecycle()).toBe('pending')
    setOptionReplies[1]!.resolve(ACCEPTED)
    await launch.promptDeliveryResult

    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 7, key: 'model', value: 'gpt-picked' },
      { method: 'agentSession.setOption', fence: 7, key: 'effort', value: 'high' },
      { method: 'agentSession.send' }
    ])
    expect(lifecycle()).toBeNull()
  })

  it('applies a pick made while the earlier ones are being applied', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-2' })
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    await settle()
    expect(setOptionReplies).toHaveLength(1)

    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-repicked')
    setOptionReplies[0]!.resolve(ACCEPTED)
    await settle()
    expect(lifecycle()).toBe('pending')
    setOptionReplies[1]!.resolve(ACCEPTED)
    await launch.launchResult

    expect(mutations().map((mutation) => mutation.value)).toEqual(['gpt-picked', 'gpt-repicked'])
  })

  it('keeps a held tier across a model pick whose catalog does not offer it', async () => {
    const created = deferred<{ sessionId: string; fence: number }>()
    mocks.launch.mockReturnValue(created.promise)
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-tier' })
    const tierPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'serviceTier', 'priority')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-nofast')
    created.resolve({ sessionId: SESSION_ID, fence: 3 })
    await settle()
    expect(setOptionReplies).toHaveLength(2)
    for (const reply of setOptionReplies) {
      reply.resolve(ACCEPTED)
    }
    await expect(tierPick).resolves.toMatchObject({ kind: 'accepted' })
    await launch.launchResult

    expect(mutations().map(({ key, value }) => [key, value])).toEqual([
      ['model', 'gpt-nofast'],
      ['serviceTier', 'priority']
    ])
  })

  it('reports a refused pick to its picker and publishes all the same', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-3',
      prompt: 'first turn'
    })
    const pick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-missing')
    await settle()
    setOptionReplies[0]!.resolve({
      ok: false,
      refusal: {
        code: 'agent_session_operation_capacity',
        message: 'Model gpt-missing is unavailable'
      }
    })

    // The picker gets the refusal as a fact; the host's diagnostic is not kept.
    await expect(pick).resolves.toEqual({
      kind: 'refused',
      failure: { kind: 'refused', code: 'agent_session_operation_capacity' }
    })
    await expect(launch.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mutations().map((mutation) => mutation.method)).toEqual([
      'agentSession.setOption',
      'agentSession.send'
    ])
  })

  it('reports a refusal the host threw as its fact, never the bare code it carries as a message', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-4' })
    const pick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-missing')
    await settle()
    setOptionReplies[0]!.resolve(
      Promise.reject(
        new RuntimeRpcCallError({
          id: 'request-1',
          ok: false,
          error: {
            code: 'runtime_error',
            message: 'agent_session_journal_unreadable',
            data: {
              refusal: {
                code: 'agent_session_journal_unreadable',
                details: { reason: 'journalUnavailable' }
              }
            }
          },
          _meta: { runtimeId: 'runtime-1' }
        })
      )
    )

    await expect(pick).resolves.toEqual({
      kind: 'refused',
      failure: {
        kind: 'refused',
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      }
    })
  })

  it('keeps picks held through a failed start and applies them to the retry', async () => {
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: SESSION_ID, fence: 2 })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-5' })
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    await settle()
    expect(lifecycle()).toBe('failed')
    expect(mutations()).toEqual([])

    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)).toBe(true)
    expect(getStructuredAgentSessionLaunchSelection(SESSION_ID)).toEqual({
      seed: { model: 'gpt-saved-since' }
    })
    await settle()
    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 2, key: 'model', value: 'gpt-picked' }
    ])
  })

  it('discards them when the tab closes before the launch publishes', async () => {
    const created = deferred<{ sessionId: string; fence: number }>()
    mocks.launch.mockReturnValue(created.promise)
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-6' })
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')

    const otherHost = { kind: 'environment', environmentId: 'surviving-held-chat' } as const
    const survivor = structuredSessionSelectionController(otherHost, SESSION_ID, 'codex')
    survivor.issue('model', 'other-host-model', null)
    cancelStructuredAgentLaunch(WORKTREE_ID, SESSION_ID)
    expect(structuredSessionSelectionController(otherHost, SESSION_ID, 'codex')).toBe(survivor)
    expect(survivor.overlay()).toEqual({ model: 'other-host-model' })
    forgetStructuredSessionSelection(SESSION_ID, otherHost)
    created.resolve({ sessionId: SESSION_ID, fence: 1 })
    await settle()

    expect(mutations()).toEqual([])
    expect(holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-late')).toBeNull()
  })

  it('keeps held issue and settlement off the global registry serializer at N and 10N', async () => {
    for (const count of [10, 100]) {
      mocks.launch.mockReturnValue(new Promise(() => {}))
      for (let index = 0; index < count; index++) {
        const sessionId = `perf-held-${index}`
        const intent = {
          ...launchIntent({ model: 'gpt-seeded' }),
          sessionId,
          worktreeId: `perf-worktree-${index}`,
          params: {
            ...launchIntent().params,
            envelope: { ...launchIntent().params.envelope, sessionId }
          }
        }
        mocks.createIntent.mockReturnValueOnce(intent)
        startStructuredAgentLaunch(intent.worktreeId, 'codex', { requestId: sessionId })
      }
      const sessionId = 'perf-held-0'
      const state = getStructuredLaunchStateBySessionId(sessionId)!
      const selection = state.selection
      const seed = selection.seed
      const changed = vi.fn()
      const global = vi.fn()
      const unsubscribe = subscribeStructuredAgentLaunchStatus(global)
      const controller = structuredSessionSelectionController(
        state.intent.target,
        sessionId,
        'codex'
      )
      const stop = controller.subscribe(changed)
      const storage = vi.spyOn(Storage.prototype, 'setItem')
      const pick = holdStructuredAgentSessionLaunchOption(sessionId, 'model', 'gpt-picked')
      await applyStructuredLaunchHeldOptions(state, { sessionId, fence: 1 }, false)
      setOptionReplies.at(-1)!.resolve({ ok: true, value: { key: 'model', value: 'gpt-picked' } })
      await expect(pick).resolves.toEqual({ kind: 'accepted', options: { model: 'gpt-picked' } })
      await settle()
      expect(state.selection).toBe(selection)
      expect(state.selection.seed).toBe(seed)
      expect(seed).toEqual({ model: 'gpt-seeded' })
      expect(global).not.toHaveBeenCalled()
      expect(storage).not.toHaveBeenCalled()
      expect(changed).toHaveBeenCalledTimes(3)
      expect(mocks.settingsWrite).toHaveBeenLastCalledWith(state.intent.target, {
        type: 'apply-picks',
        agent: 'codex',
        picks: [{ modelId: 'gpt-picked', optionId: 'model', value: 'gpt-picked' }]
      })
      console.info(
        'selection-held-notifier-work',
        JSON.stringify({
          pendingLaunches: count,
          globalNotifications: 0,
          serializerWrites: 0,
          scopedNotifications: changed.mock.calls.length
        })
      )
      storage.mockRestore()
      stop()
      unsubscribe()
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()
    }
  })
})
