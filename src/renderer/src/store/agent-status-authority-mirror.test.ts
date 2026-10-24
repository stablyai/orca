import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState, useAppStore } from './index'
import { getAgentStatusOwner } from './agent-status-commit'
import { applyAgentStatusPatch } from './agent-status-patch'
import { applyWebSessionTabsStorePatch } from '@/runtime/web-session-tabs-sync/store-patch'

const pane = 'source:11111111-1111-4111-8111-111111111111'
const destination = 'destination:22222222-2222-4222-8222-222222222222'
afterEach(() => vi.useRealTimers())

describe('accepted status authority boundaries', () => {
  it('discards prepared aliases and observations without changing another store', () => {
    vi.useFakeTimers()
    const a = createStore(createAppState),
      b = createStore(createAppState)
    const status = getAgentStatusOwner(a),
      other = getAgentStatusOwner(b)
    const authority = status.observations().getAuthorityId()
    expect(() =>
      status.transact(() => {
        a.getState().transferAgentPaneAuthority({ fromPaneKey: pane, toPaneKey: destination })
        a.getState().setAgentStatus(pane, { state: 'working', prompt: 'aborted' })
        throw new Error('abort')
      })
    ).toThrow('abort')
    expect(status.getSnapshot()).toEqual({})
    a.getState().setAgentStatus(pane, { state: 'working', prompt: 'A' })
    b.getState().setAgentStatus(pane, { state: 'working', prompt: 'B' })
    expect(status.getEntry(pane)?.prompt).toBe('A')
    expect(other.getEntry(pane)?.prompt).toBe('B')
    expect(other.getEntry(destination)).toBeUndefined()
    expect(status.observations().getAuthorityId()).toBe(authority)
    a.getState().transferAgentPaneAuthority({ fromPaneKey: pane, toPaneKey: destination })
    a.getState().setAgentStatus(pane, { state: 'done', prompt: 'accepted' })
    expect(status.getEntry(destination)?.prompt).toBe('accepted')
    expect(other.getEntry(pane)?.prompt).toBe('B')
  })

  it('installs host status through the canonical owner and aborts a throwing mirror builder', () => {
    vi.useFakeTimers()
    const owner = getAgentStatusOwner(useAppStore),
      original = owner.getState()
    const entry = {
      paneKey: pane,
      agentType: 'codex',
      state: 'working',
      prompt: 'host',
      stateHistory: [],
      stateStartedAt: 10,
      updatedAt: 20
    } as const
    const observed = vi.fn(() => {
      expect(useAppStore.getState()).not.toHaveProperty('agentStatusByPaneKey')
      expect(owner.getEntry(pane)).toEqual(entry)
    })
    const unsubscribe = useAppStore.subscribe(observed)
    try {
      expect(() =>
        applyWebSessionTabsStorePatch(
          () => {
            throw new Error('abort mirror')
          },
          { frames: [] }
        )
      ).toThrow('abort mirror')
      expect(owner.getState()).toBe(original)
      applyWebSessionTabsStorePatch(
        () => ({
          agentStatusByPaneKey: { [pane]: { ...entry, stateHistory: [] } },
          sortEpoch: original.sortEpoch + 1
        }),
        { frames: [] }
      )
      expect(observed).toHaveBeenCalledTimes(1)
      expect(owner.getEntry(pane)?.prompt).toBe('host')
      expect(useAppStore.getState()).not.toHaveProperty('agentStatusByPaneKey')
    } finally {
      unsubscribe()
      applyAgentStatusPatch(useAppStore, original)
    }
  })
})

describe('review acceptance and root observer integration', () => {
  it('does not let an aborted nested mirror return a usable settle receipt', async () => {
    const { parkUntilHostSessionMirrorHydrates, resetHostSessionMirrorHydrationForTests } =
      await import('@/runtime/host-session-mirror-hydration')
    resetHostSessionMirrorHydrationForTests()
    const owner = getAgentStatusOwner(useAppStore)
    const before = useAppStore.getState()
    const hydrated = vi.fn()
    const environmentId = 'review-acceptance-host',
      worktreeId = 'review-acceptance-workspace'
    parkUntilHostSessionMirrorHydrates(environmentId, worktreeId, hydrated)
    let settle: (() => void) | undefined
    expect(() =>
      owner.transact(() => {
        settle = applyWebSessionTabsStorePatch(() => ({ sortEpoch: before.sortEpoch + 1 }), {
          frames: [
            { environmentId, worktreeId, decision: { apply: true, settlesHostMirror: true } }
          ]
        })
        throw new Error('abort outer mirror fold')
      })
    ).toThrow('abort outer mirror fold')
    expect(useAppStore.getState()).toBe(before)
    settle?.()
    owner.transact(() => useAppStore.setState({ sortEpoch: before.sortEpoch + 2 }))
    settle?.()
    useAppStore.setState(before, true)
    resetHostSessionMirrorHydrationForTests()
    expect(hydrated).not.toHaveBeenCalled()
  })
  it.each([10, 100])(
    'counts full unified-map enumeration with the root exit owner at %i chats',
    async (count) => {
      const { getTabAgentExitOwner } = await import('@/lib/tab-agent-exit-owner')
      const a = createStore(createAppState),
        status = getAgentStatusOwner(a)
      const { structuredChatTabs } = await import('@/lib/structured-chat-tab-index')
      const previousMap = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `wt${i}`,
          [
            {
              id: `agent-session:s${i}`,
              entityId: `s${i}`,
              worktreeId: `wt${i}`,
              contentType: 'agent-session',
              executionHostId: 'local',
              label: 'chat',
              groupId: 'g',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        ])
      )
      let walks = 0
      const before = new Proxy(previousMap, {
        ownKeys(target) {
          walks++
          return Reflect.ownKeys(target)
        }
      })
      a.setState({ unifiedTabsByWorktree: before })
      structuredChatTabs(before)
      const stop = getTabAgentExitOwner(status).start()
      const next = new Proxy(
        { ...previousMap, wt0: [{ ...previousMap.wt0[0], label: 'changed' }] },
        {
          ownKeys(target) {
            walks++
            return Reflect.ownKeys(target)
          }
        }
      )
      walks = 0
      a.setState({ unifiedTabsByWorktree: next })
      stop()
      console.log('REVIEW_ROOT_UNIFIED_MAP_WALKS', count, walks)
      expect(walks).toBeLessThanOrEqual(1)
    }
  )
})

it.each([false, true])(
  'uses the actual outer receipt for nested mirror capability (patchless %s)',
  async (patchless) => {
    const { parkUntilHostSessionMirrorHydrates, resetHostSessionMirrorHydrationForTests } =
      await import('@/runtime/host-session-mirror-hydration')
    resetHostSessionMirrorHydrationForTests()
    const owner = getAgentStatusOwner(useAppStore)
    const initial = useAppStore.getState()
    const environmentId = 'accepted-nested-host',
      worktreeId = 'accepted-nested-workspace'
    const hydrated = vi.fn()
    const effects = vi.fn()
    let settle: (() => void) | undefined
    const stop = useAppStore.subscribe(() => {
      expect(effects).not.toHaveBeenCalled()
      settle?.()
      expect(hydrated).toHaveBeenCalledTimes(1)
    })
    try {
      parkUntilHostSessionMirrorHydrates(environmentId, worktreeId, hydrated)
      owner.transact((tx) => {
        settle = applyWebSessionTabsStorePatch(
          (state) => (patchless ? state : { sortEpoch: initial.sortEpoch + 1 }),
          {
            frames: [
              { environmentId, worktreeId, decision: { apply: true, settlesHostMirror: true } }
            ]
          }
        )
        settle()
        expect(hydrated).not.toHaveBeenCalled()
        tx.afterCommit(effects)
        if (patchless) {
          useAppStore.setState({ sortEpoch: initial.sortEpoch + 1 })
        }
      })
      expect(effects).toHaveBeenCalledTimes(1)
      expect(hydrated).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      useAppStore.setState(initial, true)
      resetHostSessionMirrorHydrationForTests()
    }
  }
)

it('accepts identity-equal evidence without an app write', async () => {
  const { parkUntilHostSessionMirrorHydrates, resetHostSessionMirrorHydrationForTests } =
    await import('@/runtime/host-session-mirror-hydration')
  resetHostSessionMirrorHydrationForTests()
  const initial = useAppStore.getState()
  const hydrated = vi.fn(),
    app = vi.fn()
  const stop = useAppStore.subscribe(app)
  try {
    parkUntilHostSessionMirrorHydrates('patchless-host', 'patchless-workspace', hydrated)
    const settle = applyWebSessionTabsStorePatch((state) => state, {
      frames: [
        {
          environmentId: 'patchless-host',
          worktreeId: 'patchless-workspace',
          decision: { apply: true, settlesHostMirror: true }
        }
      ]
    })
    expect(useAppStore.getState()).toBe(initial)
    expect(app).not.toHaveBeenCalled()
    expect(hydrated).not.toHaveBeenCalled()
    settle()
    expect(hydrated).toHaveBeenCalledTimes(1)
  } finally {
    stop()
    resetHostSessionMirrorHydrationForTests()
  }
})
