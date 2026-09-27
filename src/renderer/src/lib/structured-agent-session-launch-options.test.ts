// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

type CallParams = {
  envelope?: { expectedRuntimeFence?: number | null }
  key?: string
  value?: string
}

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: CallParams) => Promise<unknown>>(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  launch: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: vi.fn(),
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
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
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchSelection,
  holdStructuredAgentSessionLaunchOption
} from './structured-agent-session-launch-options'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import {
  markStructuredAgentSessionLaunchPublished,
  resetStructuredAgentLaunchRegistryForTests,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'

const WORKTREE_ID = 'wt-1'
const SESSION_ID = 'session-1'

function launchIntent(seedOptions?: Record<string, string>): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId: WORKTREE_ID,
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

describe('picks made while a chat launches', () => {
  let setOptionReplies: Deferred<unknown>[]

  beforeEach(() => {
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
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { prompt: 'first turn' })

    const modelPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
    created.resolve({ sessionId: SESSION_ID, fence: 7 })
    await settle()

    // The host published the tab, but the launch is not published until its picks land.
    markStructuredAgentSessionLaunchPublished(WORKTREE_ID, SESSION_ID)
    expect(lifecycle()).toBe('pending')
    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 7, key: 'model', value: 'gpt-picked' }
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
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex')
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

  it('reports a refused pick to its picker and publishes all the same', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { prompt: 'first turn' })
    const pick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-missing')
    await settle()
    setOptionReplies[0]!.resolve({
      ok: false,
      refusal: { code: 'agent_session_option_invalid', message: 'Model gpt-missing is unavailable' }
    })

    await expect(pick).resolves.toEqual({
      kind: 'refused',
      message: 'Model gpt-missing is unavailable'
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

  it('keeps picks held through a failed start and applies them to the retry', async () => {
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: SESSION_ID, fence: 2 })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    await settle()
    expect(lifecycle()).toBe('failed')
    expect(mutations()).toEqual([])

    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)).toBe(true)
    // The retried create seeds from the saved selection of now.
    expect(getStructuredAgentSessionLaunchSelection(SESSION_ID)).toEqual({
      seed: { model: 'gpt-saved-since' },
      held: { model: 'gpt-picked' }
    })
    await settle()
    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 2, key: 'model', value: 'gpt-picked' }
    ])
  })

  it('discards them when the tab closes before the launch publishes', async () => {
    const created = deferred<{ sessionId: string; fence: number }>()
    mocks.launch.mockReturnValue(created.promise)
    startStructuredAgentLaunch(WORKTREE_ID, 'codex')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')

    cancelStructuredAgentLaunch(WORKTREE_ID, SESSION_ID)
    created.resolve({ sessionId: SESSION_ID, fence: 1 })
    await settle()

    expect(mutations()).toEqual([])
    expect(holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-late')).toBeNull()
  })

  it('folds an accepted pick into what the launch reports it runs', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
    await settle()
    const seen: unknown[] = []
    subscribeStructuredAgentLaunchStatus(() =>
      seen.push(getStructuredAgentSessionLaunchSelection(SESSION_ID))
    )
    setOptionReplies[0]!.resolve({
      ok: true,
      value: { key: 'effort', value: 'high', options: { model: 'gpt-seeded', effort: 'high' } }
    })
    await settle()

    expect(seen[0]).toEqual({ seed: { model: 'gpt-seeded', effort: 'high' }, held: {} })
    expect(lifecycle()).toBeNull()
  })
})
