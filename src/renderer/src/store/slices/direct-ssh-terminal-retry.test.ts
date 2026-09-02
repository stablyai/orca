import { describe, expect, it } from 'vitest'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../../shared/ssh-types'
import type { DirectSshPaneRetryAttemptId } from './direct-ssh-terminal-recovery'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'

const WORKTREE_ID = 'repo-ssh::/work/demo'
const TAB_ID = 'tab-ssh'

function authority(epoch = 'epoch-1', generation = 1): DirectSshAuthority {
  return {
    targetId: 'target',
    providerEpoch: epoch as SshProviderEpoch,
    connectionGeneration: generation
  }
}

function seedStore(ptyId: string | null = null) {
  const store = createTestStore()
  const currentAuthority = authority()
  store.setState({
    repos: [
      {
        id: 'repo-ssh',
        path: '/work/demo',
        displayName: 'demo',
        badgeColor: '#000',
        addedAt: 1,
        connectionId: 'target',
        executionHostId: 'ssh:target'
      }
    ],
    worktreesByRepo: {
      'repo-ssh': [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo-ssh',
          path: '/work/demo',
          hostId: 'ssh:target'
        })
      ]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID, ptyId })]
    },
    ptyIdsByTabId: { [TAB_ID]: ptyId ? [ptyId] : [] },
    lastKnownRelayPtyIdByTabId: ptyId ? { [TAB_ID]: ptyId } : {},
    sshConnectionStates: new Map([
      [
        'target',
        {
          targetId: 'target',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          providerEpoch: currentAuthority.providerEpoch,
          connectionGeneration: currentAuthority.connectionGeneration
        }
      ]
    ])
  })
  return store
}

describe('direct SSH terminal retry ledger', () => {
  it('invalidates a non-null binding without current-authority evidence atomically', () => {
    const ptyId = 'ssh:target@@pty-old'
    const store = seedStore(ptyId)
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    expect(store.getState().invalidateStaleDirectSshTargetPtyBindings(authority())).toBe(1)
    unsubscribe()

    expect(publications).toBe(1)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].ptyId).toBeNull()
    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([])
    expect(store.getState().lastKnownRelayPtyIdByTabId[TAB_ID]).toBe(ptyId)
  })

  it('preserves a healthy current-authority sibling in the same workspace', () => {
    const store = seedStore('ssh:target@@pty-stale')
    const sibling = makeTab({
      id: 'tab-healthy',
      worktreeId: WORKTREE_ID,
      ptyId: 'ssh:target@@pty-healthy'
    })
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: [...state.tabsByWorktree[WORKTREE_ID], sibling]
      },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        'tab-healthy': ['ssh:target@@pty-healthy']
      },
      directSshLivePtyBindingByTabId: {
        'tab-healthy': {
          attemptId: 'healthy-attempt' as DirectSshPaneRetryAttemptId,
          authority: authority(),
          tabGeneration: 0,
          ptyId: 'ssh:target@@pty-healthy'
        }
      }
    }))

    expect(store.getState().invalidateStaleDirectSshTargetPtyBindings(authority())).toBe(1)

    const tabs = store.getState().tabsByWorktree[WORKTREE_ID]
    expect(tabs.find((tab) => tab.id === TAB_ID)?.ptyId).toBeNull()
    expect(tabs.find((tab) => tab.id === 'tab-healthy')).toBe(sibling)
    expect(store.getState().ptyIdsByTabId['tab-healthy']).toEqual(['ssh:target@@pty-healthy'])
    expect(store.getState().directSshLivePtyBindingByTabId['tab-healthy']).toBeDefined()
  })

  it('keeps one pending attempt and acknowledges success after the live commit', () => {
    const store = seedStore()
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_000)).toBe(1)
    unsubscribe()
    expect(publications).toBe(1)
    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_001)).toBe(0)
    const retried = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(retried).toMatchObject({ generation: 1, pendingActivationSpawn: true })
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toMatchObject({
      tabGeneration: 1,
      startedAt: 1_000
    })
    const attempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    const pendingBeforeStaleSettlement = store.getState().directSshPaneRetryByTabId
    store.getState().settleDirectSshPaneRetry({
      status: 'failed',
      tabId: TAB_ID,
      attemptId: attempt.attemptId,
      authority: attempt.authority,
      tabGeneration: attempt.tabGeneration - 1
    })
    expect(store.getState().directSshPaneRetryByTabId).toBe(pendingBeforeStaleSettlement)

    store.getState().settleDirectSshPaneRetry(
      {
        status: 'failed',
        tabId: TAB_ID,
        attemptId: attempt.attemptId,
        authority: authority('stale-epoch', 0),
        tabGeneration: attempt.tabGeneration
      },
      1_001
    )
    expect(store.getState().directSshPaneRetryByTabId).toBe(pendingBeforeStaleSettlement)

    store.getState().settleDirectSshPaneRetry({
      status: 'success',
      tabId: TAB_ID,
      attemptId: attempt.attemptId,
      authority: attempt.authority,
      tabGeneration: attempt.tabGeneration,
      ptyId: 'ssh:target@@pty-new'
    })
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBeDefined()

    store
      .getState()
      .updateTabPtyId(
        TAB_ID,
        'ssh:target@@pty-new',
        undefined,
        'wrong-attempt' as DirectSshPaneRetryAttemptId
      )
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBeDefined()
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].ptyId).toBeNull()
    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([])
    expect(store.getState().lastKnownRelayPtyIdByTabId[TAB_ID]).toBeUndefined()

    store.getState().updateTabPtyId(TAB_ID, 'ssh:target@@pty-new', undefined, attempt.attemptId)
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toMatchObject({
      tabGeneration: 1,
      ptyId: 'ssh:target@@pty-new'
    })
    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_002)).toBe(0)
  })

  it('re-arms one failure and exhausts the authority chain after two attempts', () => {
    const store = seedStore()

    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_000)).toBe(1)
    const firstAttempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    store.getState().settleDirectSshPaneRetry(
      {
        status: 'failed',
        tabId: TAB_ID,
        attemptId: firstAttempt.attemptId,
        authority: firstAttempt.authority,
        tabGeneration: firstAttempt.tabGeneration
      },
      2_000
    )
    const secondAttempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    expect(secondAttempt.tabGeneration).toBe(2)
    store.getState().settleDirectSshPaneRetry(
      {
        status: 'timed-out',
        tabId: TAB_ID,
        attemptId: secondAttempt.attemptId,
        authority: secondAttempt.authority,
        tabGeneration: secondAttempt.tabGeneration
      },
      3_000
    )

    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBe(secondAttempt)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generation).toBe(2)
    expect(store.getState().retryDirectSshTargetPanes(authority(), 30_999)).toBe(0)
    expect(store.getState().retryDirectSshTargetPanes(authority(), 31_000)).toBe(0)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generation).toBe(2)
  })

  it('keeps one split-pane attempt valid until every sibling settles', () => {
    const store = seedStore()
    store.setState({
      terminalLayoutsByTabId: {
        [TAB_ID]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
            second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
          },
          activeLeafId: '11111111-1111-4111-8111-111111111111',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_000)).toBe(1)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].pendingActivationSpawn).toBe(2)
    const firstAttempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    const firstPtyId = 'ssh:target@@pty-first'
    const siblingPtyId = 'ssh:target@@pty-sibling'

    store.getState().updateTabPtyId(TAB_ID, firstPtyId, undefined, firstAttempt.attemptId)
    store.getState().updateTabPtyId(TAB_ID, siblingPtyId, undefined, firstAttempt.attemptId)

    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([firstPtyId, siblingPtyId])
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].ptyId).toBe(firstPtyId)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].pendingActivationSpawn).toBeUndefined()
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toMatchObject({
      attemptId: firstAttempt.attemptId,
      ptyId: firstPtyId
    })

    store.getState().settleDirectSshPaneRetry(
      {
        status: 'failed',
        tabId: TAB_ID,
        attemptId: firstAttempt.attemptId,
        authority: firstAttempt.authority,
        tabGeneration: firstAttempt.tabGeneration
      },
      2_000
    )
    const secondAttempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    expect(secondAttempt.tabGeneration).toBe(2)
    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([])

    const beforeStaleCallback = store.getState()
    store
      .getState()
      .updateTabPtyId(TAB_ID, 'ssh:target@@pty-stale', undefined, firstAttempt.attemptId)
    store.getState().settleDirectSshPaneRetry(
      {
        status: 'failed',
        tabId: TAB_ID,
        attemptId: firstAttempt.attemptId,
        authority: firstAttempt.authority,
        tabGeneration: firstAttempt.tabGeneration
      },
      2_001
    )

    expect(store.getState().tabsByWorktree).toBe(beforeStaleCallback.tabsByWorktree)
    expect(store.getState().ptyIdsByTabId).toBe(beforeStaleCallback.ptyIdsByTabId)
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBe(secondAttempt)
    expect(store.getState().directSshPaneRetryHistoryByTabId[TAB_ID].attemptedAt).toEqual([
      1_000, 2_000
    ])

    const secondFirstPtyId = 'ssh:target@@pty-second-first'
    const secondSiblingPtyId = 'ssh:target@@pty-second-sibling'
    store.getState().updateTabPtyId(TAB_ID, secondFirstPtyId, undefined, secondAttempt.attemptId)
    store.getState().settleDirectSshPaneRetry(
      {
        status: 'failed',
        tabId: TAB_ID,
        attemptId: secondAttempt.attemptId,
        authority: secondAttempt.authority,
        tabGeneration: secondAttempt.tabGeneration
      },
      3_000
    )
    store.getState().updateTabPtyId(TAB_ID, secondSiblingPtyId, undefined, secondAttempt.attemptId)

    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([secondFirstPtyId, secondSiblingPtyId])
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().retryDirectSshTargetPanes(authority(), 3_001)).toBe(0)
  })

  it('promotes a surviving split PTY without revoking its exact retry lease', () => {
    const store = seedStore()
    store.setState({ activeWorktreeId: null })
    store.getState().retryDirectSshTargetPanes(authority(), 1_000)
    const attempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    const firstPtyId = 'ssh:target@@pty-first'
    const siblingPtyId = 'ssh:target@@pty-sibling'
    store.getState().updateTabPtyId(TAB_ID, firstPtyId, undefined, attempt.attemptId)
    store.getState().updateTabPtyId(TAB_ID, siblingPtyId, undefined, attempt.attemptId)

    store.getState().clearTabPtyId(TAB_ID, firstPtyId)

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].ptyId).toBe(siblingPtyId)
    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([siblingPtyId])
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toMatchObject({
      attemptId: attempt.attemptId,
      ptyId: siblingPtyId
    })
    expect(store.getState().retryDirectSshTargetPanes(authority(), 2_000)).toBe(0)
  })

  it('keeps exact retry authority through a primary-exit gap before a sibling binds', () => {
    const store = seedStore()
    store.setState({
      activeWorktreeId: null,
      terminalLayoutsByTabId: {
        [TAB_ID]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
            second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
          },
          activeLeafId: '11111111-1111-4111-8111-111111111111',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })
    store.getState().retryDirectSshTargetPanes(authority(), 1_000)
    const attempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    const firstPtyId = 'ssh:target@@pty-first'
    const siblingPtyId = 'ssh:target@@pty-sibling'

    store.getState().updateTabPtyId(TAB_ID, firstPtyId, undefined, attempt.attemptId)
    store.getState().clearTabPtyId(TAB_ID, firstPtyId)

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0]).toMatchObject({
      ptyId: null,
      pendingActivationSpawn: true
    })
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toMatchObject({
      attemptId: attempt.attemptId,
      ptyId: firstPtyId
    })
    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_001)).toBe(0)

    store.getState().updateTabPtyId(TAB_ID, siblingPtyId, undefined, attempt.attemptId)

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].ptyId).toBe(siblingPtyId)
    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([siblingPtyId])
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toMatchObject({
      attemptId: attempt.attemptId,
      ptyId: siblingPtyId
    })
  })

  it('does not turn two thirty-one-second timeouts into an unbounded retry chain', () => {
    const store = seedStore()

    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_000)).toBe(1)
    const firstAttempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    store.getState().settleDirectSshPaneRetry(
      {
        status: 'timed-out',
        tabId: TAB_ID,
        attemptId: firstAttempt.attemptId,
        authority: firstAttempt.authority,
        tabGeneration: firstAttempt.tabGeneration
      },
      32_000
    )
    const secondAttempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    expect(secondAttempt.tabGeneration).toBe(2)

    store.getState().settleDirectSshPaneRetry(
      {
        status: 'timed-out',
        tabId: TAB_ID,
        attemptId: secondAttempt.attemptId,
        authority: secondAttempt.authority,
        tabGeneration: secondAttempt.tabGeneration
      },
      63_000
    )

    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBe(secondAttempt)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generation).toBe(2)
    expect(store.getState().retryDirectSshTargetPanes(authority(), 63_000)).toBe(0)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generation).toBe(2)
  })

  it('re-arms only the exact failed tab', () => {
    const store = seedStore()
    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_000)).toBe(1)
    const firstAttempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    const sibling = makeTab({
      id: 'tab-unrelated',
      worktreeId: WORKTREE_ID,
      ptyId: null
    })
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: [...state.tabsByWorktree[WORKTREE_ID], sibling]
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, [sibling.id]: [] }
    }))

    store.getState().settleDirectSshPaneRetry(
      {
        status: 'failed',
        tabId: TAB_ID,
        attemptId: firstAttempt.attemptId,
        authority: firstAttempt.authority,
        tabGeneration: firstAttempt.tabGeneration
      },
      2_000
    )

    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]?.tabGeneration).toBe(2)
    expect(store.getState().directSshPaneRetryByTabId[sibling.id]).toBeUndefined()
    expect(
      store.getState().tabsByWorktree[WORKTREE_ID].find((tab) => tab.id === sibling.id)
        ?.generation ?? 0
    ).toBe(0)
  })

  it('re-arms a pending attempt when its bound SSH PTY exits', () => {
    const store = seedStore()
    store.getState().retryDirectSshTargetPanes(authority(), 1_000)
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((tab) => ({
          ...tab,
          ptyId: 'ssh:target@@pty-failed'
        }))
      },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        [TAB_ID]: ['ssh:target@@pty-failed']
      }
    }))

    store.getState().clearTabPtyId(TAB_ID, 'ssh:target@@pty-failed')

    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().retryDirectSshTargetPanes(authority(), 2_000)).toBe(1)
  })

  it('clearing a successful binding re-arms it without discarding relay identity', () => {
    const store = seedStore()
    store.getState().retryDirectSshTargetPanes(authority(), 1_000)
    const attempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    store.getState().updateTabPtyId(TAB_ID, 'ssh:target@@pty-new', undefined, attempt.attemptId)

    store.getState().clearTabPtyId(TAB_ID)

    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().lastKnownRelayPtyIdByTabId[TAB_ID]).toBe('ssh:target@@pty-new')
    expect(store.getState().retryDirectSshTargetPanes(authority(), 2_000)).toBe(1)
  })

  it('removes successful evidence when a snapshot overwrites the live binding', () => {
    const store = seedStore()
    store.getState().retryDirectSshTargetPanes(authority(), 1_000)
    const attempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    store.getState().updateTabPtyId(TAB_ID, 'ssh:target@@pty-new', undefined, attempt.attemptId)
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((tab) => ({
          ...tab,
          ptyId: null
        }))
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, [TAB_ID]: [] }
    }))

    expect(store.getState().retryDirectSshTargetPanes(authority(), 2_000)).toBe(1)
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBeDefined()
  })

  it('keeps snapshot-restored PTY hints eligible for corrective retry', () => {
    const store = seedStore()
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((tab) => ({
          ...tab,
          ptyId: 'ssh:target@@pty-snapshot'
        }))
      },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        [TAB_ID]: ['ssh:target@@pty-snapshot']
      }
    }))

    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_000)).toBe(1)
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toMatchObject({
      authority: authority(),
      tabGeneration: 1
    })
  })

  it('clears a snapshot hint without superseding its current pending attempt', () => {
    const store = seedStore()
    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_000)).toBe(1)
    const pending = store.getState().directSshPaneRetryByTabId[TAB_ID]
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((tab) => ({
          ...tab,
          ptyId: 'ssh:target@@pty-snapshot'
        }))
      },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        [TAB_ID]: ['ssh:target@@pty-snapshot']
      }
    }))

    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_001)).toBe(0)

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0]).toMatchObject({
      generation: 1,
      ptyId: null
    })
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBe(pending)
    expect(store.getState().directSshPaneRetryHistoryByTabId[TAB_ID].attemptedAt).toEqual([1_000])
  })

  it('rotates obsolete pending, success, and retry history by exact authority', () => {
    const store = seedStore()
    store.getState().retryDirectSshTargetPanes(authority(), 1_000)
    const attempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    store.getState().updateTabPtyId(TAB_ID, 'ssh:target@@pty-new', undefined, attempt.attemptId)
    const nextAuthority = authority('epoch-2', 2)
    store.setState({
      sshConnectionStates: new Map([
        [
          'target',
          {
            targetId: 'target',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: nextAuthority.providerEpoch,
            connectionGeneration: nextAuthority.connectionGeneration
          }
        ]
      ])
    })

    expect(store.getState().retryDirectSshTargetPanes(nextAuthority, 1_001)).toBe(1)
    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]?.authority).toEqual(nextAuthority)
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().directSshPaneRetryHistoryByTabId[TAB_ID]).toEqual({
      authority: nextAuthority,
      attemptedAt: [1_001]
    })
  })

  it('fails closed when the store no longer names the exact authority', () => {
    const store = seedStore()
    const stale = authority('stale', 0)
    const before = store.getState()

    expect(store.getState().retryDirectSshTargetPanes(stale, 1_000)).toBe(0)
    expect(store.getState().invalidateStaleDirectSshTargetPtyBindings(stale)).toBe(0)
    expect(store.getState().tabsByWorktree).toBe(before.tabsByWorktree)
    expect(store.getState().directSshPaneRetryByTabId).toBe(before.directSshPaneRetryByTabId)
  })

  it('retries a stale-catalog tab from retained SSH ownership exactly once', () => {
    const store = seedStore()
    store.setState({
      repos: [],
      worktreesByRepo: {},
      lastKnownRelayPtyIdByTabId: { [TAB_ID]: 'ssh:target@@pty-retained' },
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID, ptyId: null })],
        local: [makeTab({ id: 'tab-local', worktreeId: 'local', ptyId: null })]
      }
    })

    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_000)).toBe(1)
    expect(store.getState().retryDirectSshTargetPanes(authority(), 1_001)).toBe(0)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generation).toBe(1)
    expect(store.getState().tabsByWorktree.local[0].generation ?? 0).toBe(0)
  })

  it('removes all direct SSH retry ledgers when a tab closes', () => {
    const store = seedStore()
    store.getState().retryDirectSshTargetPanes(authority(), 1_000)
    const attempt = store.getState().directSshPaneRetryByTabId[TAB_ID]
    store.getState().updateTabPtyId(TAB_ID, 'ssh:target@@pty-live', undefined, attempt.attemptId)
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toBeDefined()
    store.setState((state) => ({
      directSshPaneRetryByTabId: {
        ...state.directSshPaneRetryByTabId,
        [TAB_ID]: {
          attemptId: 'pending-close' as DirectSshPaneRetryAttemptId,
          authority: authority(),
          tabGeneration: 1,
          startedAt: 2_000
        }
      }
    }))

    store.getState().closeTab(TAB_ID, { reason: 'pty-exit' })

    expect(store.getState().directSshPaneRetryByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().directSshLivePtyBindingByTabId[TAB_ID]).toBeUndefined()
    expect(store.getState().directSshPaneRetryHistoryByTabId[TAB_ID]).toBeUndefined()
  })
})
