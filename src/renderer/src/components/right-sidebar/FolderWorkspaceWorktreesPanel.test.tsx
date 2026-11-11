// @vitest-environment happy-dom

import { act, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  LINEAGE_CHILDREN_INLINE_OFFSET,
  getLineageChildrenInlineStyle
} from '@/components/sidebar/worktree-list/rows/indentation'

type MockStoreState = {
  activeWorktreeId: string | null
  activeWorkspaceKey: string | null
  settings?: {
    experimentalNewWorktreeCardStyle?: boolean
  }
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

type MockCardProps = {
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
}

const testState = vi.hoisted(() => {
  const store: MockStoreState = {
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    folderWorkspaces: [],
    workspaceLineageByChildKey: {},
    worktreeLineageById: {},
    worktreesByRepo: {},
    repos: []
  }
  const cardProps: MockCardProps[] = []
  const cardClicks: string[] = []
  const cardDoubleClicks: string[] = []
  const cardDragStarts: string[] = []
  return { store, cardProps, cardClicks, cardDoubleClicks, cardDragStarts }
})

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: MockStoreState) => T): T => selector(testState.store)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      values && name in values ? String(values[name]) : match
    )
}))

vi.mock('@/components/sidebar/workspace-card/surface/WorktreeCard', () => ({
  default: (props: MockCardProps) => {
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
        onDoubleClick={() => testState.cardDoubleClicks.push(props.worktree.id)}
        onDragStart={() => testState.cardDragStarts.push(props.worktree.id)}
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
    testState.cardDoubleClicks = []
    testState.cardDragStarts = []
    testState.store = {
      activeWorktreeId: folderWorkspaceKey('folder-1'),
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      settings: { experimentalNewWorktreeCardStyle: false },
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
  function seedThreeLevelLineage(): { parent: Worktree; child: Worktree; grandchild: Worktree } {
    const parent = makeWorktree({
      id: 'repo-1::/parent',
      displayName: 'Parent card',
      instanceId: 'parent-instance',
      lastActivityAt: 50
    })
    const child = makeWorktree({
      id: 'repo-1::/child',
      displayName: 'Child card',
      instanceId: 'child-instance',
      lastActivityAt: 30
    })
    const grandchild = makeWorktree({
      id: 'repo-1::/grandchild',
      displayName: 'Grandchild card',
      instanceId: 'grandchild-instance',
      lastActivityAt: 10
    })
    testState.store.worktreesByRepo = { 'repo-1': [parent, child, grandchild] }
    testState.store.workspaceLineageByChildKey = {
      [parent.id]: makeWorkspaceLineage(parent, 'folder-1')
    }
    testState.store.worktreeLineageById = {
      [child.id]: makeWorktreeLineage(child, parent),
      [grandchild.id]: makeWorktreeLineage(grandchild, child)
    }
    return { parent, child, grandchild }
  }

  function cardFor(worktreeId: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-worktree-id="${worktreeId}"]`)
  }

  function renderedCardIds(): string[] {
    return [...container.querySelectorAll('[data-testid="worktree-card"]')].map(
      (node) => node.getAttribute('data-worktree-id') ?? ''
    )
  }

  function latestPropsFor(worktreeId: string): MockCardProps | undefined {
    return testState.cardProps.findLast((props) => props.worktree.id === worktreeId)
  }

  it('keeps a collapsed parent advertising its children while hiding its descendants', () => {
    const { parent, child, grandchild } = seedThreeLevelLineage()

    renderPanel()

    act(() => {
      cardFor(child.id)?.querySelector<HTMLButtonElement>('[data-testid="lineage-toggle"]')?.click()
    })

    expect(renderedCardIds()).toEqual([parent.id, child.id])
    const collapsedProps = latestPropsFor(child.id)
    expect(collapsedProps?.lineageCollapsed).toBe(true)
    expect(collapsedProps?.lineageChildCount).toBe(1)
    expect(collapsedProps?.lineageChildrenStyle).toEqual(
      getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)
    )
    expect(collapsedProps?.onLineageToggle).toBeTypeOf('function')

    act(() => {
      cardFor(child.id)?.querySelector<HTMLButtonElement>('[data-testid="lineage-toggle"]')?.click()
    })

    expect(renderedCardIds()).toEqual([parent.id, child.id, grandchild.id])
  })

  it('keeps both leaf siblings free of a middle sibling subtree', () => {
    const root = makeWorktree({
      id: 'repo-1::/gap-root',
      displayName: 'Gap root',
      instanceId: 'gap-root-instance',
      lastActivityAt: 90
    })
    const firstLeaf = makeWorktree({
      id: 'repo-1::/first-leaf',
      displayName: 'First leaf',
      instanceId: 'first-leaf-instance',
      lastActivityAt: 50
    })
    const middleSibling = makeWorktree({
      id: 'repo-1::/middle-sibling',
      displayName: 'Middle sibling',
      instanceId: 'middle-sibling-instance',
      lastActivityAt: 40
    })
    const lastLeaf = makeWorktree({
      id: 'repo-1::/last-leaf',
      displayName: 'Last leaf',
      instanceId: 'last-leaf-instance',
      lastActivityAt: 30
    })
    const middleChild = makeWorktree({
      id: 'repo-1::/middle-child',
      displayName: 'Middle child',
      instanceId: 'middle-child-instance',
      lastActivityAt: 10
    })
    testState.store.worktreesByRepo = {
      'repo-1': [root, firstLeaf, middleSibling, lastLeaf, middleChild]
    }
    testState.store.workspaceLineageByChildKey = {
      [root.id]: makeWorkspaceLineage(root, 'folder-1')
    }
    testState.store.worktreeLineageById = {
      [firstLeaf.id]: makeWorktreeLineage(firstLeaf, root),
      [middleSibling.id]: makeWorktreeLineage(middleSibling, root),
      [lastLeaf.id]: makeWorktreeLineage(lastLeaf, root),
      [middleChild.id]: makeWorktreeLineage(middleChild, middleSibling)
    }

    renderPanel()

    const ids = renderedCardIds()
    expect(ids).toEqual([root.id, firstLeaf.id, middleSibling.id, middleChild.id, lastLeaf.id])
    expect(new Set(ids).size).toBe(ids.length)
    const nestedSelector = `[data-worktree-id="${middleChild.id}"]`
    expect(cardFor(firstLeaf.id)?.querySelector(nestedSelector)).toBeNull()
    expect(cardFor(lastLeaf.id)?.querySelector(nestedSelector)).toBeNull()
    expect(cardFor(middleSibling.id)?.querySelector(nestedSelector)).not.toBeNull()
    expect(latestPropsFor(firstLeaf.id)?.lineageChildren).toBeUndefined()
    expect(latestPropsFor(lastLeaf.id)?.lineageChildren).toBeUndefined()
  })
})
