import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { HostSectionRow } from './host-section-rows'
import {
  getCyclableWorktreeIds,
  getCyclableWorktrees,
  resolveCycleAnchorWorktreeId,
  resolveCycledWorktreeId
} from './worktree-keyboard-cycle'

describe('resolveCycleAnchorWorktreeId', () => {
  const worktreeIds = ['a', 'b', 'c']

  it('prefers the active workspace over history', () => {
    expect(
      resolveCycleAnchorWorktreeId({
        activeWorktreeId: 'b',
        navHistory: ['a'],
        navHistoryIndex: 0,
        worktreeIds
      })
    ).toBe('b')
  })

  it('falls back to the history cursor when closing a workspace cleared the selection', () => {
    expect(
      resolveCycleAnchorWorktreeId({
        activeWorktreeId: null,
        navHistory: ['a', 'b'],
        navHistoryIndex: 1,
        worktreeIds
      })
    ).toBe('b')
  })

  it('ignores history entries ahead of the cursor', () => {
    expect(
      resolveCycleAnchorWorktreeId({
        activeWorktreeId: null,
        navHistory: ['a', 'b', 'c'],
        navHistoryIndex: 1,
        worktreeIds
      })
    ).toBe('b')
  })

  it('walks back past page entries and workspaces that are gone', () => {
    expect(
      resolveCycleAnchorWorktreeId({
        activeWorktreeId: null,
        navHistory: [
          'a',
          'deleted',
          'tasks',
          { kind: 'task-detail', source: 'linear', issue: { id: 'iss-1' } }
        ] as never,
        navHistoryIndex: 3,
        worktreeIds
      })
    ).toBe('a')
  })

  it('keeps a collapsed-group anchor so it can still enter from the matching end', () => {
    // Why: resolveCycledWorktreeId treats an uncyclable anchor as "enter from the far
    // end"; resolving it away to a history hit would silently move the user's place.
    expect(
      resolveCycleAnchorWorktreeId({
        activeWorktreeId: 'collapsed',
        navHistory: ['a'],
        navHistoryIndex: 0,
        worktreeIds
      })
    ).toBe('collapsed')
  })

  it('returns null when neither selection nor history resolves', () => {
    expect(
      resolveCycleAnchorWorktreeId({
        activeWorktreeId: null,
        navHistory: [],
        navHistoryIndex: -1,
        worktreeIds
      })
    ).toBeNull()
  })
})

describe('resolveCycledWorktreeId', () => {
  const worktreeIds = ['a', 'b', 'c']

  it('steps to the next and previous worktree', () => {
    expect(resolveCycledWorktreeId({ worktreeIds, anchorWorktreeId: 'a', direction: 'down' })).toBe(
      'b'
    )
    expect(resolveCycledWorktreeId({ worktreeIds, anchorWorktreeId: 'b', direction: 'up' })).toBe(
      'a'
    )
  })

  it('wraps around at both ends', () => {
    expect(resolveCycledWorktreeId({ worktreeIds, anchorWorktreeId: 'c', direction: 'down' })).toBe(
      'a'
    )
    expect(resolveCycledWorktreeId({ worktreeIds, anchorWorktreeId: 'a', direction: 'up' })).toBe(
      'c'
    )
  })

  it('enters from the matching end when the active worktree is not cyclable', () => {
    // Why: the active worktree stays selected inside a group the user collapsed,
    // so it is absent from the cyclable list; arrowing should not always jump to
    // the top.
    expect(
      resolveCycledWorktreeId({ worktreeIds, anchorWorktreeId: 'hidden', direction: 'down' })
    ).toBe('a')
    expect(
      resolveCycledWorktreeId({ worktreeIds, anchorWorktreeId: 'hidden', direction: 'up' })
    ).toBe('c')
    expect(
      resolveCycledWorktreeId({ worktreeIds, anchorWorktreeId: null, direction: 'down' })
    ).toBe('a')
  })

  it('has nothing to cycle to when every group is collapsed', () => {
    expect(
      resolveCycledWorktreeId({ worktreeIds: [], anchorWorktreeId: 'a', direction: 'down' })
    ).toBe(null)
  })
})

describe('getCyclableWorktreeIds', () => {
  const repo = {
    id: 'repo-1',
    path: '/repo-1',
    displayName: 'Repo 1',
    badgeColor: '#737373',
    addedAt: 1
  }

  function worktree(id: string, isPinned = false): HostSectionRow & { type: 'item' } {
    return {
      type: 'item',
      rowKey: `row:${id}`,
      sectionKey: isPinned ? 'pinned' : 'repo:repo-1',
      worktree: { id, repoId: repo.id, isPinned } as never,
      repo: repo as never,
      depth: 0,
      groupDepth: 0,
      lineageTrail: [],
      isLastLineageChild: false,
      lineageChildCount: 0
    }
  }

  it('keeps a pinned worktree cyclable when only its natural group is collapsed', () => {
    // Why: `single-location` renders a pinned worktree solely under Pinned, so
    // rebuilding the cycle list from natural groups alone would drop it.
    const rows: HostSectionRow[] = [worktree('pinned-a', true), worktree('plain-b')]

    expect(getCyclableWorktreeIds(rows, 'single-location')).toEqual(['pinned-a', 'plain-b'])
  })

  it('counts a duplicated pinned worktree once', () => {
    const rows: HostSectionRow[] = [
      worktree('dup', true),
      { ...worktree('dup'), rowKey: 'row:dup-natural' },
      worktree('plain-b')
    ]

    expect(getCyclableWorktreeIds(rows, 'duplicate-in-groups')).toEqual(['dup', 'plain-b'])
  })

  it('keeps same-id rows on different hosts independently cyclable', () => {
    const rows: HostSectionRow[] = [
      {
        ...worktree('shared'),
        worktree: { id: 'shared', repoId: repo.id, hostId: 'local' } as never
      },
      {
        ...worktree('shared'),
        rowKey: 'row:shared:ssh',
        worktree: { id: 'shared', repoId: repo.id, hostId: 'ssh:host-b' } as never
      }
    ]

    expect(getCyclableWorktrees(rows, 'single-location').map((item) => item.hostId)).toEqual([
      'local',
      'ssh:host-b'
    ])
  })

  it('cycles folder workspaces in their rendered position', () => {
    // Why: Cmd+1-9 already numbers them, so a visible folder workspace the arrow
    // chord skipped was unreachable from the keyboard for no stated reason.
    const rows: HostSectionRow[] = [
      {
        type: 'folder-workspace',
        key: 'folder-workspace:folder-1',
        folderWorkspace: { id: 'folder-1', projectGroupId: 'group-1' } as never,
        projectGroup: { id: 'group-1' } as never,
        depth: 0,
        groupDepth: 0
      },
      worktree('plain-b')
    ]

    expect(getCyclableWorktreeIds(rows, 'single-location')).toEqual([
      folderWorkspaceKey('folder-1'),
      'plain-b'
    ])
  })

  it('drops worktrees the sidebar elided inside a collapsed host section', () => {
    // Why: addHostSectionRows omits a collapsed host's rows entirely, so anything
    // it removed must not stay reachable by arrowing.
    const rows: HostSectionRow[] = [
      {
        type: 'host-header',
        key: 'host:local',
        hostId: 'local' as never,
        kind: 'local',
        label: 'This computer',
        detail: '',
        health: 'local',
        collapsed: true,
        count: 1
      },
      worktree('visible-after-host')
    ]

    expect(getCyclableWorktreeIds(rows, 'single-location')).toEqual(['visible-after-host'])
  })
})

describe('WorktreeList keyboard cycling', () => {
  it('cycles over the rendered rows instead of rebuilding a parallel layout', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./worktree-list/navigation/use-keyboard.ts', import.meta.url)),
      'utf8'
    )
    const navigateWorktree = source.slice(
      source.indexOf('const navigateWorktree = useCallback('),
      source.indexOf('const handleContainerKeyDown = useCallback(')
    )

    // Why: a second buildRows call drifts from the rendered layout (host sections,
    // pinned placement); cycling must read the same rows the viewport renders.
    expect(navigateWorktree).toContain('getCyclableWorktreeRows(rows, pinnedDisplayPolicy)')
    expect(navigateWorktree).toContain('getCyclableRowIdentity')
    // Why: the active host is stored resolved while a local row is unqualified; comparing raw identities wraps to the top.
    expect(navigateWorktree).toContain('resolveActiveCycleIdentity')
    expect(navigateWorktree).not.toContain('composeWorktreeHostIdentity')
    expect(navigateWorktree).toContain('executionHostId: nextWorktree.hostId')
    expect(navigateWorktree).toContain('resolveCycledWorktreeId')
    expect(navigateWorktree).not.toContain('buildRows(')
  })
})
