import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import type { TerminalOrphanRecoveryState } from './web-session-terminal-orphan-recovery'

const ENVIRONMENT_ID = 'remote-runtime'
const WORKTREE_ID = 'repo::/worktree'
const HOST_TAB_ID = 'host-tab'
const MIRRORED_TAB_ID = `web-terminal-${HOST_TAB_ID}`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TERMINAL_HANDLE = 'term-live'
const REMOTE_PTY_ID = toRemoteRuntimePtyId(TERMINAL_HANDLE, ENVIRONMENT_ID)

function stateWithVerifiedBinding(): TerminalOrphanRecoveryState {
  return {
    tabsByWorktree: {
      [WORKTREE_ID]: [{ id: MIRRORED_TAB_ID, worktreeId: WORKTREE_ID } as never]
    },
    terminalLayoutsByTabId: {
      [MIRRORED_TAB_ID]: {
        root: { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: REMOTE_PTY_ID }
      }
    },
    activeTabIdByWorktree: { [WORKTREE_ID]: MIRRORED_TAB_ID },
    activeGroupIdByWorktree: {}
  }
}

function stateWithEmptyBinding() {
  const state = stateWithVerifiedBinding()
  state.terminalLayoutsByTabId[MIRRORED_TAB_ID]!.ptyIdsByLeafId = {}
  return state
}

function pendingSnapshot() {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'runtime-restart',
    snapshotVersion: 2,
    activeGroupId: null,
    activeTabId: `${HOST_TAB_ID}::${LEAF_ID}`,
    activeTabType: 'terminal' as const,
    tabs: [
      {
        type: 'terminal' as const,
        id: `${HOST_TAB_ID}::${LEAF_ID}`,
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        title: 'Codex',
        ptyId: 'pty-live',
        isActive: true,
        status: 'pending-handle' as const,
        terminal: null
      }
    ]
  }
}

describe('web session pending terminal handle recovery', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())
  afterEach(() => vi.unstubAllGlobals())

  it('holds the verified binding while the exact previous handle is still host-owned', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [
          {
            handle: TERMINAL_HANDLE,
            ptyId: 'pty-live',
            incarnationId: 'inc-live',
            orphaned: false
          }
        ],
        totalCount: 1,
        truncated: false
      }
    }))

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithVerifiedBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ status: 'ready', terminal: TERMINAL_HANDLE })]
    })
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ handles: [TERMINAL_HANDLE] })
      })
    )
  })

  it('recovers a persisted empty binding through an exact pane resolution', async () => {
    const readySnapshot = {
      ...pendingSnapshot(),
      publicationEpoch: 'resolved-adopted',
      snapshotVersion: 3,
      tabs: [
        {
          ...pendingSnapshot().tabs[0]!,
          status: 'ready' as const,
          terminal: TERMINAL_HANDLE
        }
      ]
    }
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.resolvePane') {
        return {
          ok: true as const,
          result: {
            terminal: {
              handle: TERMINAL_HANDLE,
              tabId: HOST_TAB_ID,
              leafId: LEAF_ID,
              ptyId: 'pty-live',
              connected: true,
              worktreeId: WORKTREE_ID
            }
          }
        }
      }
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: {
            terminals: [
              {
                handle: TERMINAL_HANDLE,
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true
              }
            ],
            topologyRevisions: { [WORKTREE_ID]: 4 },
            totalCount: 1,
            truncated: false,
            hostScope: { hostIds: [ENVIRONMENT_ID], omittedHostIds: [] }
          }
        }
      }
      return {
        ok: true as const,
        result: { adopted: true, topologyRevision: 5, snapshot: readySnapshot }
      }
    })

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithEmptyBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toEqual(readySnapshot)
    expect(call).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'terminal.resolvePane',
        params: { paneKey: `${HOST_TAB_ID}:${LEAF_ID}`, worktreeId: WORKTREE_ID }
      })
    )
    expect(call).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'terminal.list' }))
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'terminal.adoptOrphans' })
    )
  })

  it('keeps an empty binding pending when pane resolution proves a different owner', async () => {
    const call = vi.fn(async ({ method }: { method: string }) =>
      method === 'terminal.resolvePane'
        ? {
            ok: true as const,
            result: {
              terminal: {
                handle: TERMINAL_HANDLE,
                tabId: 'other-tab',
                leafId: LEAF_ID,
                ptyId: 'pty-live',
                connected: true,
                worktreeId: WORKTREE_ID
              }
            }
          }
        : { ok: true as const, result: {} }
    )

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      stateWithEmptyBinding(),
      pendingSnapshot(),
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentTabId: HOST_TAB_ID,
          leafId: LEAF_ID,
          status: 'pending-handle',
          terminal: null
        })
      ])
    )
    expect(call).toHaveBeenCalledOnce()
  })

  it('keeps an empty binding pending when the host does not support pane resolution', async () => {
    const call = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'method_not_found', message: 'method_not_found' }
    }))

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      stateWithEmptyBinding(),
      pendingSnapshot(),
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'pending-handle', terminal: null })
      ])
    )
    expect(call).toHaveBeenCalledOnce()
  })

  it('does not retry unsupported pane resolution for the same snapshot, but retries newer versions', async () => {
    const call = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'method_not_found', message: 'method_not_found' }
    }))

    await recoverWebSessionTerminalOrphansBeforeApply(
      stateWithEmptyBinding(),
      pendingSnapshot(),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    await recoverWebSessionTerminalOrphansBeforeApply(
      stateWithEmptyBinding(),
      pendingSnapshot(),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    await recoverWebSessionTerminalOrphansBeforeApply(
      stateWithEmptyBinding(),
      { ...pendingSnapshot(), snapshotVersion: 3 },
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(call).toHaveBeenCalledTimes(2)
  })

  it('retries a transient pane-resolution failure for an unchanged replayed snapshot', async () => {
    const readySnapshot = {
      ...pendingSnapshot(),
      publicationEpoch: 'resolved-after-reconnect',
      snapshotVersion: 3,
      tabs: [
        {
          ...pendingSnapshot().tabs[0]!,
          status: 'ready' as const,
          terminal: TERMINAL_HANDLE
        }
      ]
    }
    let resolveAttempts = 0
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.resolvePane') {
        resolveAttempts += 1
        if (resolveAttempts === 1) {
          return {
            ok: false as const,
            error: { code: 'runtime_rpc_queue_overloaded', message: 'retry later' }
          }
        }
        return {
          ok: true as const,
          result: {
            terminal: {
              handle: TERMINAL_HANDLE,
              tabId: HOST_TAB_ID,
              leafId: LEAF_ID,
              ptyId: 'pty-live',
              connected: true,
              worktreeId: WORKTREE_ID
            }
          }
        }
      }
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: {
            terminals: [
              {
                handle: TERMINAL_HANDLE,
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true
              }
            ],
            topologyRevisions: { [WORKTREE_ID]: 4 },
            totalCount: 1,
            truncated: false,
            hostScope: { hostIds: [ENVIRONMENT_ID], omittedHostIds: [] }
          }
        }
      }
      return {
        ok: true as const,
        result: { adopted: true, topologyRevision: 5, snapshot: readySnapshot }
      }
    })

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithEmptyBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ status: 'pending-handle', terminal: null })]
    })
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithEmptyBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toEqual(readySnapshot)

    expect(resolveAttempts).toBe(2)
  })

  it('retries a disconnected pane resolution for an unchanged replayed snapshot', async () => {
    const readySnapshot = {
      ...pendingSnapshot(),
      publicationEpoch: 'resolved-after-disconnect',
      snapshotVersion: 3,
      tabs: [
        {
          ...pendingSnapshot().tabs[0]!,
          status: 'ready' as const,
          terminal: TERMINAL_HANDLE
        }
      ]
    }
    let resolveAttempts = 0
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.resolvePane') {
        resolveAttempts += 1
        return {
          ok: true as const,
          result: {
            terminal: {
              handle: TERMINAL_HANDLE,
              tabId: HOST_TAB_ID,
              leafId: LEAF_ID,
              ptyId: 'pty-live',
              connected: resolveAttempts > 1,
              worktreeId: WORKTREE_ID
            }
          }
        }
      }
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: {
            terminals: [
              {
                handle: TERMINAL_HANDLE,
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true
              }
            ],
            topologyRevisions: { [WORKTREE_ID]: 4 },
            totalCount: 1,
            truncated: false,
            hostScope: { hostIds: [ENVIRONMENT_ID], omittedHostIds: [] }
          }
        }
      }
      return {
        ok: true as const,
        result: { adopted: true, topologyRevision: 5, snapshot: readySnapshot }
      }
    })

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithEmptyBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ status: 'pending-handle', terminal: null })]
    })
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithEmptyBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toEqual(readySnapshot)

    expect(resolveAttempts).toBe(2)
  })

  it('keeps a legacy leaf pending without sending an invalid pane key', async () => {
    const state = stateWithEmptyBinding()
    const layout = state.terminalLayoutsByTabId[MIRRORED_TAB_ID]!
    state.terminalLayoutsByTabId[MIRRORED_TAB_ID] = {
      ...layout,
      root: { type: 'leaf', leafId: 'legacy-leaf' },
      activeLeafId: 'legacy-leaf',
      ptyIdsByLeafId: {}
    }
    const call = vi.fn()

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      pendingSnapshot(),
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'pending-handle', terminal: null })
      ])
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('holds a pending surface when its cached handle is absent from filtered inventory', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: [ENVIRONMENT_ID], omittedHostIds: [] }
      }
    }))

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithVerifiedBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ status: 'ready', terminal: TERMINAL_HANDLE })]
    })
  })

  it('accepts an exact ready replacement handle without consulting stale inventory', async () => {
    const snapshot = {
      ...pendingSnapshot(),
      publicationEpoch: 'replacement-ready',
      snapshotVersion: 3,
      tabs: [
        {
          ...pendingSnapshot().tabs[0]!,
          status: 'ready' as const,
          terminal: 'term-replacement'
        }
      ]
    }
    const call = vi.fn()

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithVerifiedBinding(),
        snapshot,
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toBe(snapshot)
    expect(call).not.toHaveBeenCalled()
  })

  it('re-adopts the exact previous handle when restart left it orphaned', async () => {
    const readySnapshot = {
      ...pendingSnapshot(),
      publicationEpoch: 'adopted',
      snapshotVersion: 3,
      tabs: [
        {
          ...pendingSnapshot().tabs[0]!,
          status: 'ready' as const,
          terminal: TERMINAL_HANDLE
        }
      ]
    }
    const call = vi.fn(async ({ method }: { method: string }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: {
              terminals: [
                {
                  handle: TERMINAL_HANDLE,
                  ptyId: 'pty-live',
                  incarnationId: 'inc-live',
                  orphaned: true
                }
              ],
              topologyRevisions: { [WORKTREE_ID]: 4 },
              totalCount: 1,
              truncated: false
            }
          }
        : {
            ok: true as const,
            result: { adopted: true, topologyRevision: 5, snapshot: readySnapshot }
          }
    )

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithVerifiedBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toEqual(readySnapshot)
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'terminal.adoptOrphans',
        params: expect.objectContaining({
          expectedTopologyRevision: 4,
          claims: [
            expect.objectContaining({
              terminal: TERMINAL_HANDLE,
              incarnationId: 'inc-live',
              tabId: HOST_TAB_ID,
              leafId: LEAF_ID
            })
          ]
        })
      })
    )
  })

  // Retargeted (#11495): this pinned the quarantine, and the quarantine was the bug. The listing
  // ran with `requireFreshPtyLiveness: true` and came back `orphaned: true` under a replacement
  // PTY, which is a host attestation that the handle is LIVE — a PTY id rotating across a host
  // relaunch is the normal case, not evidence of death. The row stays bound to the handle, which is
  // the identity the host answers on; the stale `ptyId` on the carried-over row settles on the next
  // frame. See web-session-terminal-orphan-recovery-inventory.ts.
  it('rebinds a cached handle the host now serves from a different PTY', async () => {
    const snapshot = pendingSnapshot()
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [
          {
            handle: TERMINAL_HANDLE,
            ptyId: 'pty-replacement',
            incarnationId: 'inc-replacement',
            orphaned: true
          }
        ],
        totalCount: 1,
        truncated: false
      }
    }))

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithVerifiedBinding(),
        snapshot,
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toEqual(
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            parentTabId: HOST_TAB_ID,
            leafId: LEAF_ID,
            status: 'ready',
            terminal: TERMINAL_HANDLE
          })
        ]
      })
    )
    expect(call).toHaveBeenCalledOnce()
  })

  it('holds an old-host pending surface that omits its PTY identity', async () => {
    const snapshot = pendingSnapshot()
    Reflect.deleteProperty(snapshot.tabs[0]!, 'ptyId')
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [
          {
            handle: TERMINAL_HANDLE,
            ptyId: 'pty-live',
            incarnationId: 'inc-live',
            orphaned: true
          }
        ],
        totalCount: 1,
        truncated: false
      }
    }))

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithVerifiedBinding(),
        snapshot,
        ENVIRONMENT_ID,
        { call: call as never }
      )
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ status: 'ready', terminal: TERMINAL_HANDLE })]
    })
    expect(call).toHaveBeenCalledOnce()
  })

  it('accepts authoritative removal after two inventories confirm the previous handle absent', async () => {
    const snapshot = {
      ...pendingSnapshot(),
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: [ENVIRONMENT_ID], omittedHostIds: [] }
      }
    }))

    const state = stateWithVerifiedBinding()
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
        call: call as never
      })
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ status: 'ready', terminal: TERMINAL_HANDLE })]
    })
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
        call: call as never
      })
    ).resolves.toBe(snapshot)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('fences list and adoption to the captured environment pairing revision', async () => {
    const readySnapshot = {
      ...pendingSnapshot(),
      publicationEpoch: 'adopted',
      snapshotVersion: 3,
      tabs: [
        {
          ...pendingSnapshot().tabs[0]!,
          status: 'ready' as const,
          terminal: TERMINAL_HANDLE
        }
      ]
    }
    const runtimeCall = vi.fn(async ({ method }: { method: string }) =>
      method === 'terminal.list'
        ? {
            ok: true as const,
            result: {
              terminals: [
                {
                  handle: TERMINAL_HANDLE,
                  ptyId: 'pty-live',
                  incarnationId: 'inc-live',
                  orphaned: true
                }
              ],
              totalCount: 1,
              truncated: false
            }
          }
        : {
            ok: true as const,
            result: { adopted: true, topologyRevision: 1, snapshot: readySnapshot }
          }
    )
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        stateWithVerifiedBinding(),
        pendingSnapshot(),
        ENVIRONMENT_ID,
        { expectedEnvironmentPairingRevision: 17 }
      )
    ).resolves.toEqual(readySnapshot)
    expect(runtimeCall).toHaveBeenCalledTimes(2)
    expect(runtimeCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedEnvironmentPairingRevision: 17 })
    )
    expect(runtimeCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedEnvironmentPairingRevision: 17 })
    )
  })
})
