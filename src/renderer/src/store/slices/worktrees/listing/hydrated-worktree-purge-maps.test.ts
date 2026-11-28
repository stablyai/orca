import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { structuredAgentSessionPaneLeaf } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace/identity/workspace-scope'
import { makeTab } from '../../../terminals/testing/terminal-tab.test-fixture'
import { readWebChatMark } from '../../agent-status/structured-sessions/chat-read-mark-aliases'
import { createWebChatReadMarkReceiptBatch } from '../../agent-status/structured-sessions/chat-read-mark-web-move'
import {
  browserChatMarks,
  CHAT,
  OLD,
  TAB
} from '../../agent-status/structured-sessions/chat-read-mark-web-test-fixture'
import { makeStructuredChatTab } from '../../tabs/tab-group.test-fixture'
import { makePersistedUI } from '../../ui/ui-slice-test-harness'
import { purgeHydratedWorktrees } from './hydrated-worktree-purge'
import type { WorktreeRefreshResult } from './worktree-refresh-result'

describe('purgeHydratedWorktrees', () => {
  it('purges dead worktree and folder keys from every session map but keeps live and uncovered remote keys', () => {
    const live = 'repoA::/a/live'
    const staleActiveOnly = 'repoA::/a/stale-active-only'
    const staleAlias = 'repoA::/a/stale-alias'
    const uncoveredSsh = 'repo-hidden::/srv/app'
    const liveFolder = folderWorkspaceKey('live-folder')
    const deletedFolder = folderWorkspaceKey('deleted-folder')
    const purged: unknown[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hydration purge reads only the fields set here.
    const state = {
      hasHydratedWorktreePurge: false,
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      repos: [{ id: 'repoA', path: '/repos/a' }],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      folderWorkspaces: [{ id: 'live-folder' }],
      wslMovedProjects: [],
      detectedWorktreesByRepo: { repoA: { authoritative: true, worktrees: [{ id: live }] } },
      tabsByWorktree: { [live]: [], [deletedFolder]: [] },
      unifiedTabsByWorktree: { [liveFolder]: [] },
      activeTabTypeByWorktree: { [live]: 'terminal', [staleActiveOnly]: 'editor' },
      contestedPrimaryHostBySessionKey: {
        [worktreeWorkspaceKey(staleAlias)]: 'local',
        [uncoveredSsh]: 'ssh:hidden-target'
      },
      purgeWorktreeTerminalState: (targets: unknown[]) => purged.push(...targets)
    } as unknown as AppState
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the purge reads only repoId, hostId and the listing result.
    const results = [
      {
        repoId: 'repoA',
        hostId: 'local',
        refresh: { result: { authoritative: true, worktrees: [{ id: live }] } }
      }
    ] as unknown as WorktreeRefreshResult[]

    purgeHydratedWorktrees(
      (patch) => Object.assign(state, patch),
      () => state,
      results
    )

    expect(state.hasHydratedWorktreePurge).toBe(true)
    expect(new Set(purged)).toEqual(
      new Set([deletedFolder, staleActiveOnly, staleAlias, worktreeWorkspaceKey(staleAlias)])
    )
  })
})

it.each([
  { placement: 'has the same conversation', sessionId: 'session-2' },
  { placement: 'was rebound', sessionId: 'session-4' }
])('keeps a late chat cutoff when the purged tab $placement', ({ sessionId }) => {
  const removed = 'repoA::/a/removed'
  const surviving = 'repoA::/a/surviving'
  const terminal = makeTab({ id: 'terminal-removed', worktreeId: removed })
  const doomedLeaf = structuredAgentSessionPaneLeaf('session-3')
  const terminalKey = 'terminal-removed:11111111-1111-4111-a111-111111111111'
  const activityClearedAtByPaneKey = {
    [OLD]: 200,
    [terminalKey]: 300,
    [`agent-chat-tab-v1-old-one:${doomedLeaf}`]: 400,
    [`agent-chat-tab-v1-old-two:${doomedLeaf}`]: 500
  }
  const store = createTestStore()
  const now = vi.spyOn(performance, 'now').mockReturnValue(10_000)
  try {
    const marks = browserChatMarks({ activityClearedAtByPaneKey })
    store.getState().hydratePersistedUI(makePersistedUI(marks.stored()), 'startup')
    expect(createWebChatReadMarkReceiptBatch()).toBeDefined()
    now.mockReturnValue(120_001)
    seedStore(store, {
      tabsByWorktree: { [removed]: [terminal] },
      unifiedTabsByWorktree: {
        [removed]: [
          makeStructuredChatTab({ id: TAB.id, worktreeId: removed, entityId: sessionId }),
          makeStructuredChatTab({
            id: 'agent-chat-tab-v1-doomed',
            worktreeId: removed,
            entityId: 'session-3'
          })
        ],
        [surviving]: [
          makeStructuredChatTab({
            id: 'agent-chat-tab-v1-surviving',
            worktreeId: surviving,
            entityId: TAB.sessionId
          })
        ]
      }
    })
    expect(createWebChatReadMarkReceiptBatch()).toBeUndefined()
    expect(store.getState().activityClearedAtByPaneKey).toEqual(activityClearedAtByPaneKey)

    store.getState().purgeWorktreeTerminalState([removed])

    const after = store.getState()
    expect(after.activityClearedAtByPaneKey).toEqual({ [OLD]: 200 })
    expect(readWebChatMark(after, 'activityClearedAtByPaneKey', CHAT)).toBe(200)
  } finally {
    now.mockRestore()
    vi.unstubAllGlobals()
  }
})
