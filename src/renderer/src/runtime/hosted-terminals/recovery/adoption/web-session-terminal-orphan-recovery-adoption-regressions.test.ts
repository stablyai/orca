import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../../shared/runtime-session-contracts'
import { resetWebSessionTabsSyncTestState } from '../../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import {
  ENVIRONMENT_ID,
  deferred,
  listResult,
  makeSnapshot,
  makeState,
  pendingSurface
} from '../testing/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from '../web-session-terminal-orphan-recovery'

vi.mock('../../../../store/index', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

describe('web session terminal orphan adoption regressions', () => {
  beforeEach(() => {
    clearWebSessionTerminalOrphanRecoveryForTests()
    resetWebSessionTabsSyncTestState()
  })

  it('retries a transient thrown adoption on an unchanged semantic frame', async () => {
    const worktree = 'repo::transient-adoption-retry'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'transient-adoption', leaves),
      tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live')] as never
    }
    let adoptionAttempts = 0
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: listResult(worktree, [
            {
              handle: 'term-live',
              ptyId: 'pty-live',
              incarnationId: 'inc-live',
              orphaned: true
            }
          ])
        }
      }
      if (method === 'session.tabs.list') {
        return {
          ok: true as const,
          result: {
            ...snapshot,
            tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live')]
          }
        }
      }
      if (method !== 'terminal.adoptOrphans') {
        throw new Error(`Unexpected method: ${method}`)
      }
      adoptionAttempts += 1
      if (adoptionAttempts === 1) {
        throw new Error('Remote runtime connection closed')
      }
      return {
        ok: true as const,
        result: {
          adopted: true,
          topologyRevision: 8,
          snapshot: {
            ...snapshot,
            publicationEpoch: 'adopted',
            tabs: [
              {
                ...pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live'),
                status: 'ready' as const,
                terminal: 'term-live'
              }
            ]
          }
        }
      }
    })

    await recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
      call: call as never
    })
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs[0]).toMatchObject({ status: 'ready', terminal: 'term-live' })
  })

  it.each([
    {
      failure: 'rpc-error',
      expectedRuntimeId: 'origin-runtime',
      reply: () => ({ ok: false, error: { code: 'unavailable', message: 'unavailable' } })
    },
    {
      failure: 'throw',
      expectedRuntimeId: 'origin-runtime',
      reply: () => {
        throw new Error('Remote runtime connection closed')
      }
    },
    {
      failure: 'invalid-snapshot',
      expectedRuntimeId: 'origin-runtime',
      reply: (snapshot: RuntimeMobileSessionTabsResult) => ({
        ok: true,
        _meta: { runtimeId: 'origin-runtime' },
        result: { ...snapshot, tabs: [null] }
      })
    },
    {
      failure: 'wrong-worktree',
      expectedRuntimeId: 'origin-runtime',
      reply: (snapshot: RuntimeMobileSessionTabsResult) => ({
        ok: true,
        _meta: { runtimeId: 'origin-runtime' },
        result: { ...snapshot, worktree: 'folder:other-host-workspace' }
      })
    },
    {
      failure: 'runtime-changed',
      expectedRuntimeId: 'origin-runtime',
      reply: (snapshot: RuntimeMobileSessionTabsResult) => ({
        ok: true,
        _meta: { runtimeId: 'replacement-runtime' },
        result: snapshot
      })
    },
    {
      failure: 'runtime-missing',
      expectedRuntimeId: 'origin-runtime',
      reply: (snapshot: RuntimeMobileSessionTabsResult) => ({ ok: true, result: snapshot })
    },
    {
      failure: 'runtime-changed-without-frame-id',
      expectedRuntimeId: undefined,
      reply: (snapshot: RuntimeMobileSessionTabsResult) => ({
        ok: true,
        _meta: { runtimeId: 'replacement-runtime' },
        result: snapshot
      })
    }
  ])(
    'retains the client epoch and retries when the post-adoption list has $failure',
    async ({ expectedRuntimeId, reply }) => {
      const worktree = 'folder:post-adoption-list'
      const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
      const state = makeState(worktree, leaves)
      const snapshot = makeSnapshot(worktree, 'renderer:host:client-navigation', leaves)
      const adopted: RuntimeMobileSessionTabsResult = {
        ...snapshot,
        publicationEpoch: 'renderer:host',
        snapshotVersion: 2,
        tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live')]
      }
      const projected = { ...adopted, publicationEpoch: 'renderer:host:client-navigation' }
      let failNextList = true
      const call = vi.fn(async ({ method }: { method: string }) => {
        if (method === 'terminal.list') {
          return {
            ok: true,
            result: listResult(worktree, [
              {
                handle: 'term-live',
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true
              }
            ])
          }
        }
        if (method === 'terminal.adoptOrphans') {
          return {
            ok: true,
            result: { adopted: true, topologyRevision: 8, snapshot: adopted },
            _meta: { runtimeId: 'origin-runtime' }
          }
        }
        if (method !== 'session.tabs.list') {
          throw new Error(`Unexpected method: ${method}`)
        }
        if (failNextList) {
          failNextList = false
          return reply(projected)
        }
        return { ok: true, result: projected, _meta: { runtimeId: 'origin-runtime' } }
      })

      const options = { call: call as never, expectedRuntimeId }
      const retained = await recoverWebSessionTerminalOrphansBeforeApply(
        state,
        snapshot,
        ENVIRONMENT_ID,
        options
      )
      expect(retained).toMatchObject({
        worktree: 'folder:post-adoption-list',
        publicationEpoch: 'renderer:host:client-navigation',
        snapshotVersion: 1,
        tabs: [
          {
            id: 'host-tab::leaf-1',
            parentTabId: 'host-tab',
            leafId: 'leaf-1',
            status: 'ready',
            terminal: 'term-live'
          }
        ]
      })
      await expect(
        recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, options)
      ).resolves.toMatchObject({
        worktree: 'folder:post-adoption-list',
        publicationEpoch: 'renderer:host:client-navigation',
        snapshotVersion: 2,
        tabs: [
          {
            id: 'host-tab::leaf-1',
            parentTabId: 'host-tab',
            leafId: 'leaf-1',
            ptyId: 'pty-live',
            status: 'ready',
            terminal: 'term-live'
          }
        ]
      })
    }
  )

  it.each([
    {
      failure: 'empty-row',
      malform: (snapshot: RuntimeMobileSessionTabsResult) => ({ ...snapshot, tabs: [{}] })
    },
    {
      failure: 'missing-selection',
      malform: (snapshot: RuntimeMobileSessionTabsResult) => ({
        ...snapshot,
        activeTabId: undefined
      })
    },
    {
      failure: 'malformed-groups',
      malform: (snapshot: RuntimeMobileSessionTabsResult) => ({
        ...snapshot,
        tabGroups: [{ id: 'group-1' }]
      })
    }
  ])(
    'preserves prior terminal bindings after a post-adoption $failure and retries',
    async ({ malform }) => {
      const worktree = 'folder:malformed-post-adoption'
      const state = makeState(worktree, [{ leafId: 'leaf-1', handle: 'term-live' }])
      state.tabsByWorktree[worktree]!.push({
        ...state.tabsByWorktree[worktree]![0]!,
        id: 'web-terminal-owned-tab',
        ptyId: 'remote:remote-runtime@@term-owned'
      })
      state.terminalLayoutsByTabId['web-terminal-owned-tab'] = {
        root: { type: 'leaf', leafId: 'leaf-owned' },
        activeLeafId: 'leaf-owned',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-owned': 'remote:remote-runtime@@term-owned' }
      }
      state.activeTabIdByWorktree[worktree] = null
      const owned = pendingSurface('owned-tab', 'leaf-owned', 'pty-owned', 'term-owned')
      const incoming: RuntimeMobileSessionTabsResult = {
        ...makeSnapshot(worktree, 'renderer:host:client-navigation', []),
        snapshotVersion: 2,
        tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live'), owned]
      }
      const projected: RuntimeMobileSessionTabsResult = {
        ...incoming,
        snapshotVersion: 3,
        tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live'), owned]
      }
      const malformed = malform(projected)
      let failNextList = true
      const call = vi.fn(async ({ method }: { method: string }) => {
        const envelope = { id: method, ok: true as const, _meta: { runtimeId: 'host-runtime' } }
        if (method === 'terminal.list') {
          return {
            ...envelope,
            result: listResult(worktree, [
              { handle: 'term-live', ptyId: 'pty-live', incarnationId: 'inc-live', orphaned: true }
            ])
          }
        }
        if (method === 'terminal.adoptOrphans') {
          return {
            ...envelope,
            result: {
              adopted: true,
              topologyRevision: 8,
              snapshot: { ...projected, publicationEpoch: 'renderer:host' }
            }
          }
        }
        if (method !== 'session.tabs.list') {
          throw new Error(`Unexpected method: ${method}`)
        }
        if (failNextList) {
          failNextList = false
          return { ...envelope, result: malformed }
        }
        return { ...envelope, result: projected }
      })

      const retained = await recoverWebSessionTerminalOrphansBeforeApply(
        state,
        incoming,
        ENVIRONMENT_ID,
        { call: call as never }
      )
      expect(retained).toMatchObject({
        worktree: 'folder:malformed-post-adoption',
        publicationEpoch: 'renderer:host:client-navigation',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [
          {
            id: 'host-tab::leaf-1',
            parentTabId: 'host-tab',
            leafId: 'leaf-1',
            ptyId: 'pty-live',
            status: 'ready',
            terminal: 'term-live'
          },
          {
            id: 'owned-tab::leaf-owned',
            parentTabId: 'owned-tab',
            leafId: 'leaf-owned',
            ptyId: 'pty-owned',
            status: 'ready',
            terminal: 'term-owned'
          }
        ]
      })
      const retried = await recoverWebSessionTerminalOrphansBeforeApply(
        state,
        incoming,
        ENVIRONMENT_ID,
        { call: call as never }
      )
      expect(retried).toMatchObject({
        worktree: 'folder:malformed-post-adoption',
        publicationEpoch: 'renderer:host:client-navigation',
        snapshotVersion: 3,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [
          {
            id: 'host-tab::leaf-1',
            parentTabId: 'host-tab',
            leafId: 'leaf-1',
            ptyId: 'pty-live',
            status: 'ready',
            terminal: 'term-live'
          },
          {
            id: 'owned-tab::leaf-owned',
            parentTabId: 'owned-tab',
            leafId: 'leaf-owned',
            ptyId: 'pty-owned',
            status: 'ready',
            terminal: 'term-owned'
          }
        ]
      })
    }
  )

  it.each([
    {
      verdict: 'retired',
      projectedSibling: [],
      retirementProofs: [
        {
          parentTabId: 'host-tab',
          leafId: 'leaf-hold',
          terminal: 'term-hold',
          ptyId: 'pty-hold',
          incarnationId: 'inc-hold'
        }
      ],
      expectedTabs: [
        { id: 'host-tab::leaf-claim', ptyId: 'pty-claim', status: 'ready', terminal: 'term-claim' }
      ],
      expectedRetirements: [
        {
          parentTabId: 'host-tab',
          leafId: 'leaf-hold',
          terminal: 'term-hold',
          ptyId: 'pty-hold',
          incarnationId: 'inc-hold'
        }
      ]
    },
    {
      verdict: 'rebound',
      projectedSibling: [
        {
          type: 'terminal' as const,
          id: 'host-tab::leaf-hold',
          parentTabId: 'host-tab',
          leafId: 'leaf-hold',
          title: 'leaf-hold',
          ptyId: 'pty-new',
          isActive: false,
          status: 'ready' as const,
          terminal: 'term-new'
        }
      ],
      retirementProofs: [],
      expectedTabs: [
        { id: 'host-tab::leaf-claim', ptyId: 'pty-claim', status: 'ready', terminal: 'term-claim' },
        { id: 'host-tab::leaf-hold', ptyId: 'pty-new', status: 'ready', terminal: 'term-new' }
      ],
      expectedRetirements: []
    },
    {
      verdict: 'pending-without-proof',
      projectedSibling: [
        {
          type: 'terminal' as const,
          id: 'host-tab::leaf-hold',
          parentTabId: 'host-tab',
          leafId: 'leaf-hold',
          title: 'leaf-hold',
          ptyId: 'pty-new',
          isActive: false,
          status: 'pending-handle' as const,
          terminal: null
        }
      ],
      retirementProofs: [],
      expectedTabs: [
        { id: 'host-tab::leaf-claim', ptyId: 'pty-claim', status: 'ready', terminal: 'term-claim' },
        { id: 'host-tab::leaf-hold', ptyId: 'pty-hold', status: 'pending-handle', terminal: null }
      ],
      expectedRetirements: []
    }
  ])(
    'merges host-projected $verdict sibling state after adoption without treating pending as exited',
    async ({ projectedSibling, retirementProofs, expectedTabs, expectedRetirements }) => {
      const worktree = 'folder:post-adoption-sibling'
      const state = makeState(worktree, [
        { leafId: 'leaf-claim', handle: 'term-claim' },
        { leafId: 'leaf-hold', handle: 'term-hold' }
      ])
      state.activeTabIdByWorktree[worktree] = null
      const snapshot: RuntimeMobileSessionTabsResult = {
        ...makeSnapshot(worktree, 'renderer:host:client-navigation', []),
        snapshotVersion: 2,
        tabs: [
          pendingSurface('host-tab', 'leaf-claim', 'pty-claim'),
          pendingSurface('host-tab', 'leaf-hold', 'pty-hold')
        ]
      }
      const adopted: RuntimeMobileSessionTabsResult = {
        ...snapshot,
        publicationEpoch: 'renderer:host',
        snapshotVersion: 3,
        tabs: [pendingSurface('host-tab', 'leaf-claim', 'pty-claim', 'term-claim')]
      }
      const projected: RuntimeMobileSessionTabsResult = {
        ...adopted,
        publicationEpoch: 'renderer:host:client-navigation',
        snapshotVersion: 4,
        tabs: [
          pendingSurface('host-tab', 'leaf-claim', 'pty-claim', 'term-claim'),
          ...projectedSibling
        ],
        retiredTerminalSurfaces: retirementProofs
      }
      const call = vi.fn(async ({ method }: { method: string }) => {
        if (method === 'terminal.list') {
          return {
            ok: true,
            result: listResult(worktree, [
              {
                handle: 'term-claim',
                ptyId: 'pty-claim',
                incarnationId: 'inc-claim',
                orphaned: true
              }
            ])
          }
        }
        if (method === 'terminal.adoptOrphans') {
          return { ok: true, result: { adopted: true, topologyRevision: 8, snapshot: adopted } }
        }
        if (method !== 'session.tabs.list') {
          throw new Error(`Unexpected method: ${method}`)
        }
        return { ok: true, result: projected }
      })
      const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
        state,
        snapshot,
        ENVIRONMENT_ID,
        { call: call as never }
      )
      expect(recovered).toMatchObject({
        worktree: 'folder:post-adoption-sibling',
        publicationEpoch: 'renderer:host:client-navigation',
        snapshotVersion: 4,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: expectedTabs,
        retiredTerminalSurfaces: expectedRetirements
      })
    }
  )

  it('does not apply an adoption result after the local tab closes while adoption is blocked', async () => {
    const worktree = 'repo::local-close-during-adoption'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const stateBeforeClose = makeState(worktree, leaves)
    const stateAfterClose = {
      ...stateBeforeClose,
      tabsByWorktree: { ...stateBeforeClose.tabsByWorktree, [worktree]: [] },
      terminalLayoutsByTabId: {},
      activeTabIdByWorktree: { [worktree]: null }
    }
    let currentState = stateBeforeClose
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'local-close-during-adoption', leaves),
      tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live')]
    }
    const adoption = deferred<unknown>()
    const entered = deferred<void>()
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: listResult(worktree, [
            {
              handle: 'term-live',
              ptyId: 'pty-live',
              incarnationId: 'inc-live',
              orphaned: true
            }
          ])
        }
      }
      if (method !== 'terminal.adoptOrphans') {
        throw new Error(`Unexpected method: ${method}`)
      }
      entered.resolve(undefined)
      return adoption.promise
    })

    const recovery = recoverWebSessionTerminalOrphansBeforeApply(
      stateBeforeClose,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never, getCurrentState: () => currentState } as never
    )
    await entered.promise
    currentState = stateAfterClose
    adoption.resolve({
      ok: true,
      result: {
        adopted: true,
        topologyRevision: 8,
        snapshot: {
          ...snapshot,
          publicationEpoch: 'adopted-after-close',
          tabs: [
            {
              ...pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live'),
              status: 'ready' as const,
              terminal: 'term-live'
            }
          ]
        }
      }
    })

    await expect(recovery).resolves.toBeNull()
  })

  it('does not apply an adoption result after the local tab moves groups while adoption is blocked', async () => {
    const worktree = 'repo::local-move-during-adoption'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const stateBeforeMove = makeState(worktree, leaves)
    const localTabId = stateBeforeMove.tabsByWorktree[worktree]![0]!.id
    const stateAfterMove = {
      ...stateBeforeMove,
      activeGroupIdByWorktree: { [worktree]: 'group-moved' },
      groupsByWorktree: {
        [worktree]: [
          {
            id: 'group-moved',
            worktreeId: worktree,
            activeTabId: localTabId,
            tabOrder: [localTabId]
          }
        ]
      },
      layoutByWorktree: { [worktree]: { type: 'leaf' as const, groupId: 'group-moved' } }
    }
    let currentState = stateBeforeMove
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'local-move-during-adoption', leaves),
      tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live')]
    }
    const adoption = deferred<unknown>()
    const entered = deferred<void>()
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: listResult(worktree, [
            {
              handle: 'term-live',
              ptyId: 'pty-live',
              incarnationId: 'inc-live',
              orphaned: true
            }
          ])
        }
      }
      if (method !== 'terminal.adoptOrphans') {
        throw new Error(`Unexpected method: ${method}`)
      }
      entered.resolve(undefined)
      return adoption.promise
    })

    const recovery = recoverWebSessionTerminalOrphansBeforeApply(
      stateBeforeMove,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never, getCurrentState: () => currentState }
    )
    await entered.promise
    currentState = stateAfterMove
    adoption.resolve({
      ok: true,
      result: {
        adopted: true,
        topologyRevision: 8,
        snapshot: {
          ...snapshot,
          publicationEpoch: 'adopted-after-move',
          tabs: [
            {
              ...pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live'),
              status: 'ready' as const,
              terminal: 'term-live'
            }
          ]
        }
      }
    })

    await expect(recovery).resolves.toBeNull()
  })
})
