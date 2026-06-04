import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { buildWorkspaceSessionPayload } from './workspace-session'

function createSnapshot(
  overrides: Partial<WorkspaceSessionSnapshot> = {}
): WorkspaceSessionSnapshot {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    ...overrides
  }
}

describe('workspace session editor drafts', () => {
  it('persists dirty editor drafts without saving clean file content', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        openFiles: [
          {
            id: '/tmp/dirty.md',
            filePath: '/tmp/dirty.md',
            relativePath: 'dirty.md',
            worktreeId: 'wt-1',
            language: 'markdown',
            mode: 'edit',
            isDirty: true
          } as never,
          {
            id: '/tmp/clean.md',
            filePath: '/tmp/clean.md',
            relativePath: 'clean.md',
            worktreeId: 'wt-1',
            language: 'markdown',
            mode: 'edit',
            isDirty: false
          } as never
        ],
        editorDrafts: {
          '/tmp/dirty.md': '',
          '/tmp/clean.md': 'clean draft should not persist'
        }
      })
    )

    expect(payload.openFilesByWorktree?.['wt-1']).toEqual([
      expect.objectContaining({
        filePath: '/tmp/dirty.md',
        dirtyDraftContent: ''
      }),
      expect.not.objectContaining({
        dirtyDraftContent: expect.any(String)
      })
    ])
  })
})
