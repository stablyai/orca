/**
 * A live publisher can return to a worktree after another one briefly owned it, and the epoch it
 * returns under is already in `retired`. The fence rejects that frame — correctly, because it
 * cannot tell it apart from a delayed frame queued by a dead generation — so the drop has to be
 * repaired from authority instead of being final.
 *
 * The sequence below is the measured one: a renderer publication, a `removed:` retraction, a
 * headless rebuild whose version restarts at 1, then the same renderer epoch returning at a higher
 * version carrying a newly published chat tab.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import {
  applyLocalStructuredSessionTabSnapshots,
  resetLocalStructuredSessionVersionForTests
} from './local-structured-session-tabs-sync'
import { localStructuredSessionEpochHistoryByWorktree } from './local-structured-session-tabs-sync/inventory-generation-fence'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'

const WORKTREE = 'folder:ws-1'
const ROOT_GROUP = 'local-root-group'
const RENDERER_EPOCH = 'renderer:53c8f87d'
const HEADLESS_EPOCH = 'headless:pty-backed:mtovsn3x'
const REMOVED_EPOCH = 'removed:mtovryl4'

afterEach(() => {
  resetWebSessionFocusIntentForTests()
  resetLocalStructuredSessionVersionForTests()
})

/**
 * The worktree must stay "known" or the trailing cursor sweep deletes its epoch history every
 * round and nothing ever accumulates in `retired` — which makes this whole scenario vacuous.
 */
function stateWithCoordinatorTerminal(): WebSessionTabsSyncState {
  const terminalTab: Tab = {
    id: 'u-term-1',
    entityId: 'term-1',
    groupId: ROOT_GROUP,
    worktreeId: WORKTREE,
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: { [WORKTREE]: ROOT_GROUP },
    activeTabId: 'u-term-1',
    activeTabIdByWorktree: { [WORKTREE]: 'u-term-1' },
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [WORKTREE]: 'terminal' },
    activeWorktreeId: WORKTREE,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    folderWorkspaces: [{ id: 'ws-1', name: 'ws', folderPath: '/tmp/ws' }],
    groupsByWorktree: {
      [WORKTREE]: [
        { id: ROOT_GROUP, worktreeId: WORKTREE, activeTabId: 'u-term-1', tabOrder: ['u-term-1'] }
      ]
    },
    layoutByWorktree: { [WORKTREE]: { type: 'leaf', groupId: ROOT_GROUP } },
    openFiles: [],
    ptyIdsByTabId: { 'term-1': ['pty-1'] },
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { [WORKTREE]: [terminalTab] },
    unreadTerminalTabs: {},
    sortEpoch: 0
  } as unknown as WebSessionTabsSyncState
}

function frame(
  publicationEpoch: string,
  snapshotVersion: number,
  sessionId: string | null
): RuntimeMobileSessionTabsResult {
  const id = sessionId ? `agent-session:${sessionId}` : null
  return {
    worktree: WORKTREE,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: ROOT_GROUP,
    activeTabId: null,
    activeTabType: null,
    tabGroups: [{ id: ROOT_GROUP, activeTabId: null, tabOrder: id ? [id] : [] }],
    tabs: id
      ? [
          {
            type: 'agent-session',
            id,
            title: 'Claude Chat',
            sessionId,
            agent: 'claude',
            isActive: false
          }
        ]
      : []
  } as RuntimeMobileSessionTabsResult
}

function chatTabs(state: WebSessionTabsSyncState): string[] {
  return (state.unifiedTabsByWorktree[WORKTREE] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.label)
}

/** Everything up to and including the drop; returns the state the repair has to fix. */
function replayUntilDrop(
  onRetiredEpochDrop?: (worktreeId: string, publicationEpoch: string) => void
): WebSessionTabsSyncState {
  let state = stateWithCoordinatorTerminal()
  state = applyLocalStructuredSessionTabSnapshots(state, [frame(RENDERER_EPOCH, 6, null)])
  state = applyLocalStructuredSessionTabSnapshots(state, [frame(REMOVED_EPOCH, 0, null)])
  state = applyLocalStructuredSessionTabSnapshots(state, [frame(HEADLESS_EPOCH, 1, null)])
  return applyLocalStructuredSessionTabSnapshots(
    state,
    [frame(RENDERER_EPOCH, 7, 'claude-1')],
    undefined,
    undefined,
    onRetiredEpochDrop ? { onRetiredEpochDrop } : {}
  )
}

describe('retired-epoch repair for a returning publisher', () => {
  it('POSITIVE CONTROL: the same frame lands when no epoch has been retired', () => {
    const applied = applyLocalStructuredSessionTabSnapshots(stateWithCoordinatorTerminal(), [
      frame(RENDERER_EPOCH, 7, 'claude-1')
    ])

    expect(chatTabs(applied)).toEqual(['Claude Chat'])
  })

  it('drops the returning publisher and reports it to the repair lane', () => {
    const onRetiredEpochDrop = vi.fn()

    const dropped = replayUntilDrop(onRetiredEpochDrop)

    expect(chatTabs(dropped)).toEqual([])
    expect(onRetiredEpochDrop).toHaveBeenCalledWith(WORKTREE, RENDERER_EPOCH)
  })

  it('lands the tab when the authoritative census re-delivers the same frame', () => {
    const dropped = replayUntilDrop()
    expect(chatTabs(dropped)).toEqual([])

    const repaired = applyLocalStructuredSessionTabSnapshots(
      dropped,
      [frame(RENDERER_EPOCH, 7, 'claude-1')],
      undefined,
      undefined,
      { authoritative: true }
    )

    expect(chatTabs(repaired)).toEqual(['Claude Chat'])
  })

  it('a non-authoritative redelivery stays dropped, so only authority repairs it', () => {
    const dropped = replayUntilDrop()

    const redelivered = applyLocalStructuredSessionTabSnapshots(dropped, [
      frame(RENDERER_EPOCH, 7, 'claude-1')
    ])

    expect(chatTabs(redelivered)).toEqual([])
  })

  it('revives only the epoch authority names, leaving other generations fenced', () => {
    const dropped = replayUntilDrop()
    applyLocalStructuredSessionTabSnapshots(
      dropped,
      [frame(RENDERER_EPOCH, 7, 'claude-1')],
      undefined,
      undefined,
      { authoritative: true }
    )

    // The census named the renderer epoch current, so the headless generation it displaced is now
    // the retired one — and a delayed frame from it must still be rejected.
    const history = localStructuredSessionEpochHistoryByWorktree.get(WORKTREE)
    expect(history?.current).toBe(RENDERER_EPOCH)
    expect(history?.retired).toContain(HEADLESS_EPOCH)
    expect(history?.retired).not.toContain(RENDERER_EPOCH)
  })
})
