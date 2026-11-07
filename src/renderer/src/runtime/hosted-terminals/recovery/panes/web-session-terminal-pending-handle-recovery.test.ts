import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from '../web-session-terminal-orphan-recovery'
import type { TerminalOrphanRecoveryState } from '../surfaces/web-session-terminal-orphan-recovery-surface'
import '../../../rpc/testing/runtime-environment-bridge-fixture'

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
      if (method === 'session.tabs.list') {
        return { ok: true as const, result: readySnapshot }
      }
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
            hostScope: { hostIds: ['local'], omittedHostIds: [] }
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
    ).resolves.toMatchObject({
      publicationEpoch: 'resolved-after-reconnect',
      snapshotVersion: 3,
      tabs: [
        {
          id: 'host-tab::11111111-1111-4111-8111-111111111111',
          leafId: '11111111-1111-4111-8111-111111111111',
          ptyId: 'pty-live',
          status: 'ready',
          terminal: 'term-live'
        }
      ]
    })
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
      if (method === 'session.tabs.list') {
        return { ok: true as const, result: readySnapshot }
      }
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
            hostScope: { hostIds: ['local'], omittedHostIds: [] }
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
    ).resolves.toMatchObject({
      publicationEpoch: 'resolved-after-disconnect',
      snapshotVersion: 3,
      tabs: [
        {
          id: 'host-tab::11111111-1111-4111-8111-111111111111',
          leafId: '11111111-1111-4111-8111-111111111111',
          ptyId: 'pty-live',
          status: 'ready',
          terminal: 'term-live'
        }
      ]
    })
  })
})
