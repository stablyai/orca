import { describe, expect, it } from 'vitest'
import {
  getContextMenuArchivedForkSessions,
  getContextMenuChildWorkspaceRecords,
  getContextMenuChildWorkspaces,
  hasSleepableWorkspaceActivity,
  isContextWorktreeDeletable,
  shouldUseNativeContextMenu,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldRemoveProjectFromContextMenu,
  shouldSuppressContextMenuFollowUpClick,
  shouldContinueDeleteSiblingPositionRestore
} from './WorktreeContextMenu'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import type { ArchivedForkableAgentSessionRecord } from '../../../../shared/agent-session-resume'

function makeWorktree(id: string, instanceId: string, label = id): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    branch: label,
    head: null,
    isBare: false,
    isMainWorktree: false,
    instanceId
  } as unknown as Worktree
}

function makeLineage(child: Worktree, parent: Worktree, createdAt: number): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'cli',
    capture: { source: 'terminal-context', confidence: 'explicit' },
    createdAt
  }
}

function makeArchivedForkSession(
  paneKey: string,
  worktreeId: string,
  archivedAt: number
): ArchivedForkableAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    prompt: `prompt ${paneKey}`,
    state: 'done',
    archivedAt,
    updatedAt: archivedAt - 1,
    archiveReason: 'retained-dismissed'
  }
}

describe('shouldUseNativeContextMenu', () => {
  it('uses the browser context menu for marked hovercard content', () => {
    const target = {
      closest: (selector: string) =>
        selector === '[data-worktree-native-context-menu]' ? ({} as Element) : null
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(true)
  })

  it('uses the browser context menu for text nodes inside marked content', () => {
    const target = {
      parentElement: {
        closest: (selector: string) =>
          selector === '[data-worktree-native-context-menu]' ? ({} as Element) : null
      }
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(true)
  })

  it('keeps the worktree context menu for unmarked targets', () => {
    const target = {
      closest: () => null
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(false)
  })
})

describe('shouldIgnoreNestedWorktreeContextMenuScope', () => {
  it('allows the context menu scope that owns the event target', () => {
    const currentScope = {} as EventTarget
    const target = {
      closest: () => currentScope
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(false)
  })

  it('ignores context menu events owned by a nested scope', () => {
    const currentScope = {} as EventTarget
    const nestedScope = {} as Element
    const target = {
      closest: () => nestedScope
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(true)
  })

  it('ignores context menu events from text nodes inside a nested scope', () => {
    const currentScope = {} as EventTarget
    const nestedScope = {} as Element
    const target = {
      parentElement: {
        closest: () => nestedScope
      }
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(true)
  })

  it('allows events from unscoped targets', () => {
    const currentScope = {} as EventTarget
    const target = {
      closest: () => null
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(false)
  })
})

describe('shouldSuppressContextMenuFollowUpClick', () => {
  it('suppresses the click emitted immediately after opening a context menu', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 1_050)).toBe(true)
  })

  it('does not suppress later unrelated clicks', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 1_700)).toBe(false)
  })

  it('does not suppress clicks that predate the context menu timestamp', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 999)).toBe(false)
  })
})

describe('shouldContinueDeleteSiblingPositionRestore', () => {
  it('stops once the delete row position has settled even when the row remains mounted', () => {
    expect(
      shouldContinueDeleteSiblingPositionRestore({
        attempts: 6,
        stableFrames: 6
      })
    ).toBe(false)
  })
})

describe('hasSleepableWorkspaceActivity', () => {
  it('treats preserved empty PTY arrays as slept, not live', () => {
    expect(
      hasSleepableWorkspaceActivity('wt-1', { 'wt-1': [{ id: 'tab-1' }] }, { 'tab-1': [] }, {})
    ).toBe(false)
  })

  it('detects live terminal and browser activity', () => {
    expect(
      hasSleepableWorkspaceActivity(
        'wt-1',
        { 'wt-1': [{ id: 'tab-1' }] },
        { 'tab-1': ['pty-1'] },
        {}
      )
    ).toBe(true)
    expect(hasSleepableWorkspaceActivity('wt-1', {}, {}, { 'wt-1': [{ id: 'browser-1' }] })).toBe(
      true
    )
  })
})

describe('project removal from workspace context menus', () => {
  it('routes primary workspace rows to project removal in non-repo grouped views', () => {
    const gitRepo = { id: 'repo-1' }
    const folderRepo = { id: 'folder-1' }

    expect(shouldRemoveProjectFromContextMenu(gitRepo, { isMainWorktree: true })).toBe(true)
    expect(shouldRemoveProjectFromContextMenu(folderRepo, { isMainWorktree: true })).toBe(true)
    expect(shouldRemoveProjectFromContextMenu(gitRepo, { isMainWorktree: false })).toBe(false)
    expect(shouldRemoveProjectFromContextMenu(null, { isMainWorktree: true })).toBe(false)
  })

  it('treats additional folder workspace rows as deletable workspace rows', () => {
    const folderRepo = { kind: 'folder' as const }

    expect(isContextWorktreeDeletable({ isMainWorktree: false }, folderRepo)).toBe(true)
    expect(isContextWorktreeDeletable({ isMainWorktree: true }, folderRepo)).toBe(false)
    expect(isContextWorktreeDeletable({ isMainWorktree: false }, null)).toBe(false)
  })
})

describe('getContextMenuChildWorkspaces', () => {
  it('returns valid children newest first', () => {
    const parent = makeWorktree('parent', 'parent-instance')
    const older = makeWorktree('older', 'older-instance')
    const newer = makeWorktree('newer', 'newer-instance')
    const worktreeMap = new Map([
      [parent.id, parent],
      [older.id, older],
      [newer.id, newer]
    ])

    expect(
      getContextMenuChildWorkspaces(
        parent,
        {
          [older.id]: makeLineage(older, parent, 10),
          [newer.id]: makeLineage(newer, parent, 20)
        },
        worktreeMap
      ).map((child) => child.id)
    ).toEqual(['newer', 'older'])
  })

  it('drops children with stale parent or child instance lineage', () => {
    const parent = makeWorktree('parent', 'parent-instance')
    const valid = makeWorktree('valid', 'valid-instance')
    const staleParent = makeWorktree('stale-parent', 'stale-parent-instance')
    const staleChild = makeWorktree('stale-child', 'stale-child-current-instance')
    const worktreeMap = new Map([
      [parent.id, parent],
      [valid.id, valid],
      [staleParent.id, staleParent],
      [staleChild.id, staleChild]
    ])
    const staleParentLineage = makeLineage(staleParent, parent, 20)
    staleParentLineage.parentWorktreeInstanceId = 'old-parent-instance'
    const staleChildLineage = makeLineage(staleChild, parent, 30)
    staleChildLineage.worktreeInstanceId = 'old-child-instance'

    expect(
      getContextMenuChildWorkspaces(
        parent,
        {
          [valid.id]: makeLineage(valid, parent, 10),
          [staleParent.id]: staleParentLineage,
          [staleChild.id]: staleChildLineage
        },
        worktreeMap
      ).map((child) => child.id)
    ).toEqual(['valid'])
  })

  it('returns child workspace records with lineage for fork management', () => {
    const parent = makeWorktree('parent', 'parent-instance')
    const older = makeWorktree('older', 'older-instance')
    const newer = makeWorktree('newer', 'newer-instance')
    const olderLineage = makeLineage(older, parent, 10)
    const newerLineage = makeLineage(newer, parent, 20)
    const records = getContextMenuChildWorkspaceRecords(
      parent,
      {
        [older.id]: olderLineage,
        [newer.id]: newerLineage
      },
      new Map([
        [older.id, older],
        [newer.id, newer]
      ])
    )

    expect(records.map((record) => record.worktree.id)).toEqual(['newer', 'older'])
    expect(records[0].lineage).toBe(newerLineage)
    expect(records[0].createdAt).toBe(20)
  })
})

describe('getContextMenuArchivedForkSessions', () => {
  it('returns archived fork sessions for the selected worktree newest first', () => {
    expect(
      getContextMenuArchivedForkSessions('wt-1', {
        older: makeArchivedForkSession('older', 'wt-1', 10),
        other: makeArchivedForkSession('other', 'wt-2', 30),
        newer: makeArchivedForkSession('newer', 'wt-1', 20)
      }).map((record) => record.paneKey)
    ).toEqual(['newer', 'older'])
  })
})
