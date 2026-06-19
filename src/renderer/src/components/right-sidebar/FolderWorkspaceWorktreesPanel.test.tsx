// @vitest-environment happy-dom

import { act, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorktreeLineage, WorkspaceLineage } from '../../../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  LINEAGE_CHILDREN_INLINE_OFFSET,
  getLineageChildrenInlineStyle
} from '@/components/sidebar/worktree-list-indentation'

type MockStoreState = {
  activeWorktreeId: string | null
  activeWorkspaceKey: string | null
  folderWorkspaces: {
    id: string
    name: string
    folderPath: string
  }[]
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreesByRepo: Record<string, Worktree[]>
  repos: Repo[]
}

const testState = vi.hoisted(() => ({
  store: {
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    folderWorkspaces: [],
    workspaceLineageByChildKey: {},
    worktreeLineageById: {},
    worktreesByRepo: {},
    repos: []
  } as MockStoreState,
  cardProps: [] as {
    worktree: Worktree
    affiliateListMode?: boolean
    nativeDragEnabled?: boolean
    isActive?: boolean
    flushSurface?: boolean
    contentIndent?: number
    lineageChildCount?: number
    lineageCollapsed?: boolean
    lineageChildren?: ReactNode
    lineageChildrenStyle?: CSSProperties
    onLineageToggle?: (event: MouseEvent<HTMLButtonElement>) => void
  }[],
  cardClicks: [] as string[]
}))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: MockStoreState) => T): T => selector(testState.store)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values ? fallback.replace('{{value0}}', String(values.value0)) : fallback
}))

vi.mock('@/components/sidebar/WorktreeCard', () => ({
  default: (props: {
    worktree: Worktree
    affiliateListMode?: boolean
    nativeDragEnabled?: boolean
    isActive?: boolean
    flushSurface?: boolean
    contentIndent?: number
    lineageChildCount?: number
    lineageCollapsed?: boolean
    lineageChildren?: ReactNode
    lineageChildrenStyle?: CSSProperties
    onLineageToggle?: (event: MouseEvent<HTMLButtonElement>) => void
  }) => {
    testState.cardProps.push(props)
    return (
      <div
        data-testid="worktree-card"
        data-worktree-id={props.worktree.id}
        data-affiliate-list-mode={props.affiliateListMode ? 'true' : 'false'}
        data-native-drag-enabled={props.nativeDragEnabled ? 'true' : 'false'}
        data-active={props.isActive ? 'true' : 'false'}
        data-flush-surface={props.flushSurface ? 'true' : 'false'}
        data-content-indent={props.contentIndent ?? 0}
        data-lineage-child-count={props.lineageChildCount ?? 0}
        data-lineage-collapsed={props.lineageCollapsed ? 'true' : 'false'}
        style={props.lineageChildrenStyle}
        onClick={() => testState.cardClicks.push(props.worktree.id)}
      >
        {props.worktree.displayName}
        {props.lineageChildCount ? (
          <button type="button" data-testid="lineage-toggle" onClick={props.onLineageToggle}>
            toggle
          </button>
        ) : null}
        {props.lineageChildren}
      </div>
    )
  }
}))

import FolderWorkspaceWorktreesPanel from './FolderWorkspaceWorktreesPanel'

let container: HTMLDivElement
let root: Root

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    path: `/worktrees/${overrides.id}`,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeWorkspaceLineage(
  child: Worktree,
  parentFolderId: string,
  overrides: Partial<WorkspaceLineage> = {}
): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(child.id),
    childInstanceId: child.instanceId ?? null,
    parentWorkspaceKey: folderWorkspaceKey(parentFolderId),
    parentInstanceId: null,
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 1,
    ...overrides
  }
}

function makeWorktreeLineage(
  child: Worktree,
  parent: Worktree,
  overrides: Partial<WorktreeLineage> = {}
): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 1,
    ...overrides
  }
}

function renderPanel(): void {
  act(() => {
    root.render(<FolderWorkspaceWorktreesPanel />)
  })
}

describe('FolderWorkspaceWorktreesPanel', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    testState.cardProps = []
    testState.cardClicks = []
    testState.store = {
      activeWorktreeId: folderWorkspaceKey('folder-1'),
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      folderWorkspaces: [{ id: 'folder-1', name: 'Platform folder', folderPath: '/platform' }],
      workspaceLineageByChildKey: {},
      worktreeLineageById: {},
      worktreesByRepo: {},
      repos: [makeRepo()]
    }
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('shows unavailable copy outside folder workspaces', () => {
    testState.store.activeWorktreeId = 'repo-1::/worktrees/current'
    testState.store.activeWorkspaceKey = 'repo-1::/worktrees/current'

    renderPanel()

    expect(container.textContent).toContain('Workspaces are only shown for folder workspaces.')
    expect(testState.cardProps).toEqual([])
  })

  it('uses the active workspace key when active worktree id has not caught up', () => {
    const child = makeWorktree({
      id: 'repo-1::/child',
      displayName: 'Workspace-key child',
      instanceId: 'child-instance'
    })
    testState.store.activeWorktreeId = null
    testState.store.activeWorkspaceKey = folderWorkspaceKey('folder-1')
    testState.store.worktreesByRepo = { 'repo-1': [child] }
    testState.store.workspaceLineageByChildKey = {
      [child.id]: makeWorkspaceLineage(child, 'folder-1')
    }

    renderPanel()

    expect(container.textContent).toContain('Workspace-key child')
  })

  it('renders attached child worktrees as affiliate WorktreeCards in recent order', () => {
    const oldChild = makeWorktree({
      id: 'repo-1::/old',
      displayName: 'Old child',
      instanceId: 'old-instance',
      lastActivityAt: 10
    })
    const recentChild = makeWorktree({
      id: 'repo-1::/recent',
      displayName: 'Recent child',
      instanceId: 'recent-instance',
      lastActivityAt: 50
    })
    const otherFolderChild = makeWorktree({
      id: 'repo-1::/other-folder',
      displayName: 'Other folder child',
      instanceId: 'other-instance',
      lastActivityAt: 100
    })
    const staleChild = makeWorktree({
      id: 'repo-1::/stale',
      displayName: 'Stale child',
      instanceId: 'fresh-instance',
      lastActivityAt: 200
    })
    testState.store.worktreesByRepo = {
      'repo-1': [oldChild, recentChild, otherFolderChild, staleChild]
    }
    testState.store.workspaceLineageByChildKey = {
      [oldChild.id]: makeWorkspaceLineage(oldChild, 'folder-1'),
      [recentChild.id]: makeWorkspaceLineage(recentChild, 'folder-1'),
      [otherFolderChild.id]: makeWorkspaceLineage(otherFolderChild, 'folder-2'),
      [staleChild.id]: makeWorkspaceLineage(staleChild, 'folder-1', {
        childInstanceId: 'stale-instance'
      })
    }

    renderPanel()

    expect(container.textContent).toContain('2 attached worktrees')
    expect(container.textContent).not.toContain(
      'Shows worktrees attached to this folder workspace.'
    )
    expect(
      [...container.querySelectorAll('[data-testid="worktree-card"]')].map(
        (node) => node.textContent
      )
    ).toEqual(['Recent child', 'Old child'])
    expect(testState.cardProps).toHaveLength(2)
    expect(testState.cardProps.every((props) => props.affiliateListMode === true)).toBe(true)
    expect(testState.cardProps.every((props) => props.nativeDragEnabled === false)).toBe(true)
    expect(testState.cardProps.every((props) => props.flushSurface === true)).toBe(true)
  })

  it('renders nested worktree lineage under attached worktrees', () => {
    const parent = makeWorktree({
      id: 'repo-1::/parent',
      displayName: 'Parent child',
      instanceId: 'parent-instance',
      lastActivityAt: 50
    })
    const nested = makeWorktree({
      id: 'repo-1::/nested',
      displayName: 'Nested child',
      instanceId: 'nested-instance',
      lastActivityAt: 10
    })
    testState.store.worktreesByRepo = {
      'repo-1': [parent, nested]
    }
    testState.store.workspaceLineageByChildKey = {
      [parent.id]: makeWorkspaceLineage(parent, 'folder-1')
    }
    testState.store.worktreeLineageById = {
      [nested.id]: makeWorktreeLineage(nested, parent)
    }

    renderPanel()

    expect(
      [...container.querySelectorAll('[data-testid="worktree-card"]')].map((node) =>
        node.getAttribute('data-worktree-id')
      )
    ).toEqual([parent.id, nested.id])
    expect(testState.cardProps.map((props) => props.worktree.displayName)).toEqual([
      'Parent child',
      'Nested child'
    ])
    expect(testState.cardProps[0]?.lineageChildCount).toBe(1)
    expect(testState.cardProps[0]?.lineageCollapsed).toBe(false)
    expect(testState.cardProps[0]?.lineageChildrenStyle).toEqual(
      getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)
    )
    expect(testState.cardProps[0]?.contentIndent).toBe(0)

    act(() => {
      container
        .querySelectorAll<HTMLElement>('[data-testid="worktree-card"]')[1]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(testState.cardClicks).toEqual([nested.id])

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="lineage-toggle"]')?.click()
    })

    expect(container.textContent).not.toContain('Nested child')
  })

  it('omits archived attached worktrees and archived lineage descendants', () => {
    const visible = makeWorktree({
      id: 'repo-1::/visible',
      displayName: 'Visible child',
      instanceId: 'visible-instance',
      lastActivityAt: 50
    })
    const archivedDirect = makeWorktree({
      id: 'repo-1::/archived-direct',
      displayName: 'Archived direct',
      instanceId: 'archived-direct-instance',
      isArchived: true,
      lastActivityAt: 100
    })
    const archivedNested = makeWorktree({
      id: 'repo-1::/archived-nested',
      displayName: 'Archived nested',
      instanceId: 'archived-nested-instance',
      isArchived: true,
      lastActivityAt: 10
    })
    testState.store.worktreesByRepo = {
      'repo-1': [visible, archivedDirect, archivedNested]
    }
    testState.store.workspaceLineageByChildKey = {
      [visible.id]: makeWorkspaceLineage(visible, 'folder-1'),
      [archivedDirect.id]: makeWorkspaceLineage(archivedDirect, 'folder-1')
    }
    testState.store.worktreeLineageById = {
      [archivedNested.id]: makeWorktreeLineage(archivedNested, visible)
    }

    renderPanel()

    expect(
      [...container.querySelectorAll('[data-testid="worktree-card"]')].map((node) =>
        node.getAttribute('data-worktree-id')
      )
    ).toEqual([visible.id])
    expect(container.textContent).not.toContain('Archived direct')
    expect(container.textContent).not.toContain('Archived nested')
  })
})
