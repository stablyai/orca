import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
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
describe('web session terminal orphan recovery regressions', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  const ROOTLESS_ACTIVE_LEAF = '11111111-1111-4111-8111-111111111111'
  const ROOTLESS_SOLE_MAP_LEAF = '22222222-2222-4222-8222-222222222222'
  const ROOTLESS_OFF_TREE_LEAF = '33333333-3333-4333-8333-333333333333'

  // Retargeted (#11495). This previously asserted the mismatched leaf was REMOVED, and that was
  // deliberate — it kept a leaf whose pending row named a ptyId the host no longer reported from
  // lingering. But `terminal.list` ran with `requireFreshPtyLiveness: true` and answered with the
  // handle live under `pty-replacement`, so the only thing the old assertion proved was that the
  // host had relaunched the PTY. Stale-leaf accumulation is already covered by the two host-attested
  // branches in the same file (`retiredTerminalSurfaces` proof, and two authoritative inventories
  // omitting the identity), which is why this branch is the outlier. Removing on it is destructive:
  // shouldReplaceTerminalTab rebuilds the whole mirror from one frame, so a dropped leaf takes
  // ptyIdsByTabId and terminalLayoutsByTabId with it — the only surviving record of how to rebind.
  it('rebinds a PTY-mismatched leaf to the handle the host still reports live', async () => {
    const worktree = 'repo::mismatch'
    const leaves = [
      { leafId: 'leaf-bad', handle: 'term-bad' },
      { leafId: 'leaf-hold', handle: 'term-hold' }
    ]
    const state = makeState(worktree, leaves)
    const tabId = 'host-tab'
    const browser = { type: 'browser', id: 'browser-1', title: 'Docs', isActive: false } as never
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'mismatch-frame', [
        {
          ...leaves[0]!,
          incoming: pendingSurface(tabId, 'leaf-bad', 'pty-old')
        },
        {
          ...leaves[1]!,
          incoming: pendingSurface(tabId, 'leaf-hold', 'pty-hold')
        }
      ]),
      tabs: [
        browser,
        pendingSurface(tabId, 'leaf-bad', 'pty-old'),
        pendingSurface(tabId, 'leaf-hold', 'pty-hold')
      ] as never
    }
    const call = vi.fn(async () => ({
      ok: true as const,
      result: listResult(worktree, [
        {
          handle: 'term-bad',
          ptyId: 'pty-replacement',
          incarnationId: 'inc-replacement',
          orphaned: true
        }
      ])
    }))

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual([
      browser,
      expect.objectContaining({
        parentTabId: tabId,
        leafId: 'leaf-bad',
        status: 'ready',
        terminal: 'term-bad'
      }),
      expect.objectContaining({
        parentTabId: tabId,
        leafId: 'leaf-hold',
        status: 'ready',
        terminal: 'term-hold'
      })
    ])
    expect(call).toHaveBeenCalledOnce()
  })

  it('recovers a pending incoming row from a rootless active-leaf layout', async () => {
    const worktree = 'repo::rootless-active-leaf'
    const handle = 'term-rootless-active'
    const state = makeState(worktree, [{ leafId: ROOTLESS_ACTIVE_LEAF, handle }])
    const localTab = state.tabsByWorktree[worktree]![0]!
    state.terminalLayoutsByTabId[localTab.id] = {
      root: null,
      activeLeafId: ROOTLESS_ACTIVE_LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [ROOTLESS_ACTIVE_LEAF]: toRemoteRuntimePtyId(handle, ENVIRONMENT_ID)
      }
    }
    const hostTab = 'host-tab'
    const pending = pendingSurface(hostTab, ROOTLESS_ACTIVE_LEAF, 'pty-rootless-active')
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'rootless-active', []),
      tabs: [pending]
    }
    const adopted: RuntimeMobileSessionTabsResult = {
      ...snapshot,
      publicationEpoch: 'rootless-active-adopted',
      tabs: [{ ...pending, status: 'ready', terminal: handle }]
    }
    const call = vi.fn(async ({ method }: { method: string; params?: Record<string, unknown> }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: listResult(worktree, [
              {
                handle,
                ptyId: 'pty-rootless-active',
                incarnationId: 'inc-rootless-active',
                orphaned: true
              }
            ])
          }
        : {
            ok: true as const,
            result: { adopted: true, topologyRevision: 8, snapshot: adopted }
          }
    )

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
        call: call as never
      })
    ).resolves.toEqual(adopted)
    expect(call).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ handles: [handle] })
      })
    )
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'terminal.adoptOrphans',
        params: expect.objectContaining({
          claims: [expect.objectContaining({ tabId: hostTab, leafId: ROOTLESS_ACTIVE_LEAF })]
        })
      })
    )
  })

  it('recovers a missing incoming row from the sole rootless PTY binding', async () => {
    const worktree = 'repo::rootless-sole-map'
    const handle = 'term-rootless-sole'
    const state = makeState(worktree, [{ leafId: ROOTLESS_SOLE_MAP_LEAF, handle }])
    const localTab = state.tabsByWorktree[worktree]![0]!
    state.terminalLayoutsByTabId[localTab.id] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [ROOTLESS_SOLE_MAP_LEAF]: toRemoteRuntimePtyId(handle, ENVIRONMENT_ID)
      }
    }
    const hostTab = 'host-tab'
    const snapshot = makeSnapshot(worktree, 'rootless-sole', [])
    const adopted: RuntimeMobileSessionTabsResult = {
      ...snapshot,
      publicationEpoch: 'rootless-sole-adopted',
      tabs: [
        {
          ...pendingSurface(hostTab, ROOTLESS_SOLE_MAP_LEAF, 'pty-rootless-sole', handle),
          status: 'ready',
          terminal: handle
        }
      ]
    }
    const call = vi.fn(async ({ method }: { method: string; params?: Record<string, unknown> }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: listResult(worktree, [
              {
                handle,
                ptyId: 'pty-rootless-sole',
                incarnationId: 'inc-rootless-sole',
                orphaned: true
              }
            ])
          }
        : {
            ok: true as const,
            result: { adopted: true, topologyRevision: 8, snapshot: adopted }
          }
    )

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
        call: call as never
      })
    ).resolves.toEqual(adopted)
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ method: 'terminal.list' }))
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ method: 'terminal.adoptOrphans' }))
  })

  it('retains an off-tree binding without listing or claiming it', async () => {
    const worktree = 'repo::rootless-off-tree'
    const primaryHandle = 'term-rootless-primary'
    const offTreeHandle = 'term-rootless-off-tree'
    const state = makeState(worktree, [{ leafId: ROOTLESS_ACTIVE_LEAF, handle: primaryHandle }])
    const localTab = state.tabsByWorktree[worktree]![0]!
    state.terminalLayoutsByTabId[localTab.id] = {
      root: null,
      activeLeafId: ROOTLESS_ACTIVE_LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [ROOTLESS_ACTIVE_LEAF]: toRemoteRuntimePtyId(primaryHandle, ENVIRONMENT_ID),
        [ROOTLESS_OFF_TREE_LEAF]: toRemoteRuntimePtyId(offTreeHandle, ENVIRONMENT_ID)
      }
    }
    const hostTab = 'host-tab'
    const primary = pendingSurface(hostTab, ROOTLESS_ACTIVE_LEAF, 'pty-rootless-primary')
    const offTree = pendingSurface(hostTab, ROOTLESS_OFF_TREE_LEAF, 'pty-rootless-off-tree')
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'rootless-off-tree', []),
      tabs: [primary, offTree]
    }
    const adopted: RuntimeMobileSessionTabsResult = {
      ...snapshot,
      publicationEpoch: 'rootless-off-tree-adopted',
      tabs: [{ ...primary, status: 'ready', terminal: primaryHandle }]
    }
    const call = vi.fn(async ({ method }: { method: string; params?: Record<string, unknown> }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: listResult(worktree, [
              {
                handle: primaryHandle,
                ptyId: 'pty-rootless-primary',
                incarnationId: 'inc-rootless-primary',
                orphaned: true
              }
            ])
          }
        : {
            ok: true as const,
            result: { adopted: true, topologyRevision: 8, snapshot: adopted }
          }
    )

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leafId: ROOTLESS_ACTIVE_LEAF,
          status: 'ready',
          terminal: primaryHandle
        }),
        expect.objectContaining({
          leafId: ROOTLESS_OFF_TREE_LEAF,
          status: 'ready',
          terminal: offTreeHandle
        })
      ])
    )
    const listCall = call.mock.calls.find(([args]) => args.method === 'terminal.list')?.[0] as
      | { params?: unknown }
      | undefined
    expect(listCall?.params).toEqual(expect.objectContaining({ handles: [primaryHandle] }))
    const adoptionCall = call.mock.calls.find(
      ([args]) => args.method === 'terminal.adoptOrphans'
    )?.[0] as { params?: { claims?: unknown } } | undefined
    expect(adoptionCall?.params?.claims).toEqual([
      expect.objectContaining({ tabId: hostTab, leafId: ROOTLESS_ACTIVE_LEAF })
    ])
  })

  it('collapses duplicate rows for one retained surface without dropping other tabs', async () => {
    const worktree = 'repo::duplicate-surface'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const first = pendingSurface('host-tab', 'leaf-1', 'pty-live')
    const duplicate = { ...first, title: 'duplicate' }
    const browser = { type: 'browser', id: 'browser-1', title: 'Docs', isActive: false }
    const editor = { type: 'markdown', id: 'editor-1', title: 'Notes', isActive: false }
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'duplicate-surface', leaves),
      tabs: [browser, first, duplicate, editor] as never
    }
    const call = vi.fn(async () => {
      throw new Error('inventory unavailable')
    })

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toHaveLength(3)
    expect(recovered?.tabs).toEqual([
      browser,
      expect.objectContaining({
        parentTabId: 'host-tab',
        leafId: 'leaf-1',
        status: 'ready',
        terminal: 'term-live'
      }),
      editor
    ])
  })

  it('applies browser/editor updates while an unresolved terminal surface is held', async () => {
    const worktree = 'repo::nonterminal-update'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'browser-update', [leaves[0]!]),
      tabs: [
        { type: 'browser', id: 'browser-new', title: 'Updated', isActive: true } as never,
        { type: 'markdown', id: 'editor-new', title: 'Notes', isActive: false } as never,
        pendingSurface('host-tab', 'leaf-1', 'pty-live')
      ] as never
    }
    const call = vi.fn(async () => {
      throw new Error('transport unavailable')
    })

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs.slice(0, 2)).toEqual(snapshot.tabs.slice(0, 2))
    expect(recovered?.tabs[2]).toMatchObject({
      leafId: 'leaf-1',
      status: 'ready',
      terminal: 'term-live'
    })
  })

  it('lets an explicit authoritative removal bypass orphan recovery', async () => {
    const worktree = 'repo::authoritative-removal'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const removed: RuntimeMobileSessionTabsRemovedResult = {
      ...makeSnapshot(worktree, 'removed-frame', leaves),
      removed: true as const,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    const call = vi.fn()

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, removed, ENVIRONMENT_ID, {
        call: call as never
      })
    ).resolves.toBe(removed)
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'throws',
      throws: true,
      response: undefined
    },
    {
      name: 'returns a non-OK response',
      throws: false,
      response: { ok: false as const, error: { code: 'unavailable', message: 'offline' } }
    },
    {
      name: 'returns a malformed result',
      throws: false,
      response: { ok: true as const, result: { terminals: [{}] } }
    }
  ])('retains every unresolved candidate when list $name', async ({ response, throws }) => {
    const worktree = `repo::list-fallback-${String(response?.ok ?? 'throw')}`
    const leaves = [
      { leafId: 'leaf-1', handle: 'term-1' },
      { leafId: 'leaf-2', handle: 'term-2' }
    ]
    const state = makeState(worktree, leaves)
    const snapshot = makeSnapshot(worktree, 'fallback', leaves)
    const effectiveCall = vi.fn(async () => {
      if (throws) {
        throw new Error('list failed')
      }
      return response
    })

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: effectiveCall as never }
    )

    expect(recovered?.tabs).toHaveLength(2)
    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ leafId: 'leaf-1', terminal: 'term-1', status: 'ready' }),
        expect.objectContaining({ leafId: 'leaf-2', terminal: 'term-2', status: 'ready' })
      ])
    )
  })

  it('coalesces degraded frames to one active and one latest queued recovery', async () => {
    const worktree = 'repo::coalesce'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const frames = [1, 2, 3].map((version) => makeSnapshot(worktree, `frame-${version}`, leaves))
    const listOne = deferred<{ ok: true; result: ReturnType<typeof listResult> }>()
    const listTwo = deferred<{ ok: true; result: ReturnType<typeof listResult> }>()
    const calls = vi.fn(({ method }: { method: string }) => {
      if (method !== 'terminal.list') {
        throw new Error(`unexpected method ${method}`)
      }
      return calls.mock.calls.length === 1 ? listOne.promise : listTwo.promise
    })

    const first = recoverWebSessionTerminalOrphansBeforeApply(state, frames[0]!, ENVIRONMENT_ID, {
      call: calls as never
    })
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
    const superseded = recoverWebSessionTerminalOrphansBeforeApply(
      state,
      frames[1]!,
      ENVIRONMENT_ID,
      { call: calls as never }
    )
    const latest = recoverWebSessionTerminalOrphansBeforeApply(state, frames[2]!, ENVIRONMENT_ID, {
      call: calls as never
    })

    await expect(superseded).resolves.toBeNull()
    listOne.resolve({ ok: true, result: listResult(worktree, []) })
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(2))
    listTwo.resolve({ ok: true, result: listResult(worktree, []) })

    await expect(first).resolves.toBeNull()
    await expect(latest).resolves.toEqual(
      expect.objectContaining({
        tabs: [expect.objectContaining({ status: 'ready', terminal: 'term-live' })]
      })
    )
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('lets a newer fully ready frame overtake an in-flight degraded recovery', async () => {
    const worktree = 'repo::ready-overtake'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const degraded = makeSnapshot(worktree, 'degraded', leaves)
    const ready: RuntimeMobileSessionTabsResult = {
      ...degraded,
      publicationEpoch: 'ready',
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab::leaf-1',
          parentTabId: 'host-tab',
          leafId: 'leaf-1',
          title: 'Live',
          isActive: true,
          status: 'ready' as const,
          terminal: 'term-live'
        }
      ]
    }
    const list = deferred<{ ok: true; result: ReturnType<typeof listResult> }>()
    const call = vi.fn(() => list.promise)
    const stale = recoverWebSessionTerminalOrphansBeforeApply(state, degraded, ENVIRONMENT_ID, {
      call: call as never
    })
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, ready, ENVIRONMENT_ID, {
        call: call as never
      })
    ).resolves.toBe(ready)
    list.resolve({ ok: true, result: listResult(worktree, []) })
    await expect(stale).resolves.toBeNull()
  })

  it('retains a cached sibling when adoption returns only another sibling', async () => {
    const worktree = 'repo::adoption-sibling'
    const leaves = [
      { leafId: 'leaf-claim', handle: 'term-claim' },
      { leafId: 'leaf-hold', handle: 'term-hold' }
    ]
    const state = makeState(worktree, leaves)
    const tabId = 'host-tab'
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'adoption-sibling', leaves),
      tabs: [
        pendingSurface(tabId, 'leaf-claim', 'pty-claim'),
        pendingSurface(tabId, 'leaf-hold', 'pty-hold')
      ]
    }
    const adopted: RuntimeMobileSessionTabsResult = {
      ...snapshot,
      publicationEpoch: 'adopted',
      tabs: [
        {
          ...pendingSurface(tabId, 'leaf-claim', 'pty-claim', 'term-claim'),
          status: 'ready' as const,
          terminal: 'term-claim'
        }
      ]
    }
    const call = vi.fn(async ({ method }: { method: string }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: listResult(worktree, [
              {
                handle: 'term-claim',
                ptyId: 'pty-claim',
                incarnationId: 'inc-claim',
                orphaned: true
              }
            ])
          }
        : { ok: true as const, result: { adopted: true, topologyRevision: 8, snapshot: adopted } }
    )

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ leafId: 'leaf-claim', terminal: 'term-claim', status: 'ready' }),
        expect.objectContaining({ leafId: 'leaf-hold', terminal: 'term-hold', status: 'ready' })
      ])
    )
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'terminal.adoptOrphans',
        params: expect.not.objectContaining({ topology: expect.anything() })
      })
    )
  })

  it('keeps claimed-tab topology when an unresolved surface belongs to another tab', async () => {
    const worktree = 'repo::unrelated-topology'
    const claimLocalTab = 'web-terminal-claim-tab'
    const holdLocalTab = 'web-terminal-hold-tab'
    const state = {
      tabsByWorktree: {
        [worktree]: [
          { id: claimLocalTab, worktreeId: worktree },
          { id: holdLocalTab, worktreeId: worktree }
        ] as never
      },
      terminalLayoutsByTabId: {
        [claimLocalTab]: {
          root: { type: 'leaf' as const, leafId: 'leaf-claim' },
          activeLeafId: 'leaf-claim',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-claim': toRemoteRuntimePtyId('term-claim', ENVIRONMENT_ID) }
        },
        [holdLocalTab]: {
          root: { type: 'leaf' as const, leafId: 'leaf-hold' },
          activeLeafId: 'leaf-hold',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-hold': toRemoteRuntimePtyId('term-hold', ENVIRONMENT_ID) }
        }
      },
      activeTabIdByWorktree: { [worktree]: claimLocalTab },
      activeGroupIdByWorktree: { [worktree]: 'group-1' },
      groupsByWorktree: {
        [worktree]: [
          {
            id: 'group-1',
            worktreeId: worktree,
            activeTabId: claimLocalTab,
            tabOrder: [claimLocalTab, holdLocalTab]
          }
        ]
      },
      layoutByWorktree: { [worktree]: { type: 'leaf' as const, groupId: 'group-1' } }
    }
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'unrelated-topology', []),
      tabs: [
        pendingSurface('claim-tab', 'leaf-claim', 'pty-claim'),
        pendingSurface('hold-tab', 'leaf-hold', 'pty-hold')
      ]
    }
    const adopted: RuntimeMobileSessionTabsResult = {
      ...snapshot,
      publicationEpoch: 'unrelated-adopted',
      tabs: [
        {
          ...pendingSurface('claim-tab', 'leaf-claim', 'pty-claim', 'term-claim'),
          status: 'ready' as const,
          terminal: 'term-claim'
        }
      ]
    }
    const call = vi.fn(async ({ method }: { method: string }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: listResult(worktree, [
              {
                handle: 'term-claim',
                ptyId: 'pty-claim',
                incarnationId: 'inc-claim',
                orphaned: true
              }
            ])
          }
        : { ok: true as const, result: { adopted: true, topologyRevision: 8, snapshot: adopted } }
    )

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parentTabId: 'claim-tab', leafId: 'leaf-claim' }),
        expect.objectContaining({
          parentTabId: 'hold-tab',
          leafId: 'leaf-hold',
          terminal: 'term-hold'
        })
      ])
    )
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'terminal.adoptOrphans',
        params: expect.objectContaining({
          topology: expect.objectContaining({
            tabs: [expect.objectContaining({ tabId: 'claim-tab', activeLeafId: 'leaf-claim' })]
          })
        })
      })
    )
  })

  it('lets an adoption response replace a stale pre-adoption removal', async () => {
    const worktree = 'repo::adoption-replacement'
    const leaves = [
      { leafId: 'leaf-remove', handle: 'term-remove' },
      { leafId: 'leaf-claim', handle: 'term-claim' }
    ]
    const state = makeState(worktree, leaves)
    const tabId = 'host-tab'
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'adoption-replacement', leaves),
      tabs: [
        pendingSurface(tabId, 'leaf-remove', 'pty-old'),
        pendingSurface(tabId, 'leaf-claim', 'pty-claim')
      ]
    }
    const adopted: RuntimeMobileSessionTabsResult = {
      ...snapshot,
      publicationEpoch: 'adopted',
      tabs: [
        {
          ...pendingSurface(tabId, 'leaf-remove', 'pty-new', 'term-remove'),
          status: 'ready' as const,
          terminal: 'term-remove'
        },
        {
          ...pendingSurface(tabId, 'leaf-claim', 'pty-claim', 'term-claim'),
          status: 'ready' as const,
          terminal: 'term-claim'
        }
      ]
    }
    const call = vi.fn(async ({ method }: { method: string }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: listResult(worktree, [
              {
                handle: 'term-remove',
                ptyId: 'pty-new',
                incarnationId: 'inc-new',
                orphaned: true
              },
              {
                handle: 'term-claim',
                ptyId: 'pty-claim',
                incarnationId: 'inc-claim',
                orphaned: true
              }
            ])
          }
        : { ok: true as const, result: { adopted: true, topologyRevision: 8, snapshot: adopted } }
    )

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leafId: 'leaf-remove',
          terminal: 'term-remove',
          status: 'ready'
        }),
        expect.objectContaining({ leafId: 'leaf-claim', terminal: 'term-claim', status: 'ready' })
      ])
    )
  })

  it('limits recovery RPC concurrency globally across worktrees', async () => {
    const count = 8
    let active = 0
    let maxActive = 0
    const gates = Array.from({ length: count }, () =>
      deferred<{ ok: true; result: ReturnType<typeof listResult> }>()
    )
    let callIndex = 0
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method !== 'terminal.list') {
        throw new Error(`unexpected method ${method}`)
      }
      const gate = gates[callIndex++]!
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        return await gate.promise
      } finally {
        active -= 1
      }
    })
    const recoveries = Array.from({ length: count }, (_, index) => {
      const worktree = `repo::lane-${index}`
      const leaves = [{ leafId: 'leaf-1', handle: `term-${index}` }]
      return recoverWebSessionTerminalOrphansBeforeApply(
        makeState(worktree, leaves),
        makeSnapshot(worktree, `lane-${index}`, leaves),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    })

    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(4))
    expect(maxActive).toBe(4)
    for (let index = 0; index < 4; index += 1) {
      gates[index]!.resolve({ ok: true, result: listResult(`repo::lane-${index}`, []) })
    }
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(count))
    for (let index = 4; index < count; index += 1) {
      gates[index]!.resolve({ ok: true, result: listResult(`repo::lane-${index}`, []) })
    }
    await Promise.all(recoveries)
    expect(maxActive).toBe(4)
  })
})
