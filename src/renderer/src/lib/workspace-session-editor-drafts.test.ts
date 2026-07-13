import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { buildWorkspaceSessionPayload } from './workspace-session'

function createSnapshot(
  overrides: Partial<WorkspaceSessionSnapshot> = {}
): WorkspaceSessionSnapshot {
  return {
    activeRepoId: 'repo-1',
    activeWorkspaceKey: 'worktree:wt-1',
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

  it('persists the disk baseline signature only alongside a dirty draft', () => {
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
            isDirty: true,
            lastKnownDiskSignature: 'abc123'
          } as never,
          {
            id: '/tmp/clean.md',
            filePath: '/tmp/clean.md',
            relativePath: 'clean.md',
            worktreeId: 'wt-1',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            lastKnownDiskSignature: 'def456'
          } as never
        ],
        editorDrafts: {
          '/tmp/dirty.md': 'unsaved edits'
        }
      })
    )

    expect(payload.openFilesByWorktree?.['wt-1']).toEqual([
      expect.objectContaining({
        filePath: '/tmp/dirty.md',
        dirtyDraftContent: 'unsaved edits',
        lastKnownDiskSignature: 'abc123'
      }),
      // Why: a clean tab has no draft to conflict-check on restore, and
      // persisting the signature anyway would bloat every session write.
      expect.not.objectContaining({
        lastKnownDiskSignature: expect.any(String)
      })
    ])
  })

  it('persists readOnly:true and never emits a dirty draft for read-only tabs', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        openFiles: [
          {
            id: '/home/user/.claude/log.jsonl',
            filePath: '/home/user/.claude/log.jsonl',
            relativePath: '/home/user/.claude/log.jsonl',
            worktreeId: 'wt-1',
            language: 'jsonl',
            mode: 'edit',
            // Why: even if isDirty is somehow set, a read-only tab must not
            // persist a draft that a restore could write back to disk.
            isDirty: true,
            readOnly: true,
            liveTail: true
          } as never
        ],
        editorDrafts: {
          '/home/user/.claude/log.jsonl': 'stray draft that must not persist'
        }
      })
    )

    const persisted = payload.openFilesByWorktree?.['wt-1']?.[0]
    expect(persisted).toEqual(
      expect.objectContaining({
        filePath: '/home/user/.claude/log.jsonl',
        readOnly: true,
        liveTail: true
      })
    )
    expect(persisted).toEqual(
      expect.not.objectContaining({ dirtyDraftContent: expect.any(String) })
    )
  })

  it('omits readOnly for ordinary writable tabs (writable is the default)', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        openFiles: [
          {
            id: '/tmp/clean.md',
            filePath: '/tmp/clean.md',
            relativePath: 'clean.md',
            worktreeId: 'wt-1',
            language: 'markdown',
            mode: 'edit',
            isDirty: false
          } as never
        ]
      })
    )

    expect(payload.openFilesByWorktree?.['wt-1']?.[0]).toEqual(
      expect.not.objectContaining({ readOnly: expect.anything() })
    )
  })
})
