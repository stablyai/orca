import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  ENVIRONMENT_ID,
  deferred,
  listResult,
  makeSnapshot,
  makeState,
  pendingSurface
} from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'

describe('web session terminal orphan adoption regressions', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it('dedupes a stable unsupported adoption so an identical claim frame does not churn RPCs', async () => {
    const worktree = 'repo::failed-adoption-cache'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'failed-adoption', leaves),
      tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live')] as never
    }
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
      return {
        ok: false as const,
        error: { code: 'method_not_found', message: 'method_not_found' }
      }
    })

    const first = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )
    const second = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(first?.tabs[0]).toMatchObject({ status: 'ready', terminal: 'term-live' })
    expect(second?.tabs[0]).toMatchObject({ status: 'ready', terminal: 'term-live' })
    expect(call).toHaveBeenCalledTimes(2)
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

    expect(adoptionAttempts).toBe(2)
    expect(recovered?.tabs[0]).toMatchObject({ status: 'ready', terminal: 'term-live' })
  })

  it('retries a queue-overload adoption response on an unchanged semantic frame', async () => {
    const worktree = 'repo::queue-overload-adoption-retry'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'queue-overload-adoption', leaves),
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
      adoptionAttempts += 1
      if (adoptionAttempts === 1) {
        return {
          ok: false as const,
          error: { code: 'runtime_rpc_queue_overloaded', message: 'retry later' }
        }
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

    expect(adoptionAttempts).toBe(2)
    expect(recovered?.tabs[0]).toMatchObject({ status: 'ready', terminal: 'term-live' })
  })

  it('retains the claimed surface when adoption returns a malformed snapshot row', async () => {
    const worktree = 'repo::malformed-adoption'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'malformed-adoption', leaves),
      tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live')]
    }
    const call = vi.fn(async ({ method }: { method: string }) =>
      method === 'terminal.list'
        ? {
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
        : {
            ok: true as const,
            result: {
              adopted: true,
              topologyRevision: 8,
              snapshot: { ...snapshot, tabs: [null] }
            }
          }
    )

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )
    const replayed = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual([
      expect.objectContaining({ leafId: 'leaf-1', status: 'ready', terminal: 'term-live' })
    ])
    expect(replayed?.tabs).toEqual(recovered?.tabs)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('retries a transient failed adoption on replay and on a newer snapshot version', async () => {
    const worktree = 'repo::failed-adoption-version'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'failed-adoption-version', leaves),
      tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live')] as never
    }
    const newerSnapshot = { ...snapshot, snapshotVersion: snapshot.snapshotVersion + 1 }
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
        return { ok: true as const, result: newerSnapshot }
      }
      adoptionAttempts += 1
      if (adoptionAttempts === 1) {
        throw new Error('adoption unavailable')
      }
      return {
        ok: true as const,
        result: {
          adopted: true,
          topologyRevision: 8,
          snapshot: {
            ...newerSnapshot,
            publicationEpoch: 'adopted'
          }
        }
      }
    })

    await recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
      call: call as never
    })
    await recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
      call: call as never
    })
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      newerSnapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(call).toHaveBeenCalledTimes(8)
    expect(adoptionAttempts).toBe(3)
    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ leafId: 'leaf-1', status: 'ready', terminal: 'term-live' })
      ])
    )
  })

  it.each([
    'rpc-error',
    'throw',
    'invalid-snapshot',
    'wrong-worktree',
    'runtime-changed',
    'runtime-missing',
    'runtime-changed-without-frame-id'
  ])('retains the client epoch and retries when the post-adoption list has %s', async (failure) => {
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
    const projected = { ...adopted, publicationEpoch: snapshot.publicationEpoch }
    let listAttempts = 0
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
      expect(method).toBe('session.tabs.list')
      listAttempts += 1
      if (listAttempts > 1) {
        return { ok: true, result: projected, _meta: { runtimeId: 'origin-runtime' } }
      }
      if (failure === 'throw') {
        throw new Error('Remote runtime connection closed')
      }
      if (failure === 'rpc-error') {
        return { ok: false, error: { code: 'unavailable', message: 'unavailable' } }
      }
      if (failure.startsWith('runtime-')) {
        return {
          ok: true,
          result: projected,
          ...(failure === 'runtime-missing' ? {} : { _meta: { runtimeId: 'replacement-runtime' } })
        }
      }
      return {
        ok: true,
        _meta: { runtimeId: 'origin-runtime' },
        result:
          failure === 'wrong-worktree'
            ? { ...projected, worktree: 'folder:other-host-workspace' }
            : { ...projected, tabs: [null] }
      }
    })

    const options = {
      call: call as never,
      expectedRuntimeId:
        failure === 'runtime-changed-without-frame-id' ? undefined : 'origin-runtime'
    }
    const retained = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      options
    )
    expect(retained).toMatchObject({
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      tabs: [expect.objectContaining({ terminal: 'term-live', status: 'ready' })]
    })
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, options)
    ).resolves.toEqual(projected)
    expect(listAttempts).toBe(2)
  })

  it.each(['retired', 'rebound', 'pending-replacement'])(
    'honors fresh %s sibling state from the post-adoption list',
    async (verdict) => {
      const worktree = 'folder:post-adoption-sibling'
      const leaves = [
        { leafId: 'leaf-claim', handle: 'term-claim' },
        { leafId: 'leaf-hold', handle: 'term-hold' }
      ]
      const state = makeState(worktree, leaves)
      const snapshot: RuntimeMobileSessionTabsResult = {
        ...makeSnapshot(worktree, 'renderer:host:client-navigation', leaves),
        tabs: [
          pendingSurface('host-tab', 'leaf-claim', 'pty-claim'),
          pendingSurface('host-tab', 'leaf-hold', 'pty-hold')
        ]
      }
      const adopted: RuntimeMobileSessionTabsResult = {
        ...snapshot,
        publicationEpoch: 'renderer:host',
        snapshotVersion: 2,
        tabs: [pendingSurface('host-tab', 'leaf-claim', 'pty-claim', 'term-claim')]
      }
      const projected: RuntimeMobileSessionTabsResult = {
        ...adopted,
        publicationEpoch: snapshot.publicationEpoch,
        snapshotVersion: 3,
        tabs:
          verdict === 'rebound'
            ? [...adopted.tabs, pendingSurface('host-tab', 'leaf-hold', 'pty-new', 'term-new')]
            : verdict === 'pending-replacement'
              ? [...adopted.tabs, pendingSurface('host-tab', 'leaf-hold', 'pty-new')]
              : adopted.tabs,
        retiredTerminalSurfaces:
          verdict !== 'rebound'
            ? [
                {
                  parentTabId: 'host-tab',
                  leafId: 'leaf-hold',
                  terminal: 'term-hold',
                  ptyId: 'pty-hold',
                  incarnationId: 'inc-hold'
                }
              ]
            : []
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
        return { ok: true, result: projected }
      })
      await expect(
        recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
          call: call as never
        })
      ).resolves.toEqual(projected)
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
      return adoption.promise
    })

    const recovery = recoverWebSessionTerminalOrphansBeforeApply(
      stateBeforeClose,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never, getCurrentState: () => currentState } as never
    )
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.adoptOrphans' })
      )
    )
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
    expect(call).toHaveBeenCalledTimes(2)
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
      return adoption.promise
    })

    const recovery = recoverWebSessionTerminalOrphansBeforeApply(
      stateBeforeMove,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never, getCurrentState: () => currentState }
    )
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.adoptOrphans' })
      )
    )
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
    expect(call).toHaveBeenCalledTimes(2)
  })
})
