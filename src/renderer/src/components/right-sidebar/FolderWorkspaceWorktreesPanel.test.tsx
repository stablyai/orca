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
    values ? fallback.replace('{{value0}}', String(values.value0)) : fallback
}))

vi.mock('@/components/sidebar/WorktreeCard', () => ({
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

  it('keeps a three-level lineage nested in the DOM and ordered pre-order', () => {
    const { parent, child, grandchild } = seedThreeLevelLineage()

    renderPanel()

    expect(renderedCardIds()).toEqual([parent.id, child.id, grandchild.id])

    const parentCard = cardFor(parent.id)
    const childCard = cardFor(child.id)
    const grandchildCard = cardFor(grandchild.id)
    expect(parentCard?.contains(childCard)).toBe(true)
    expect(childCard?.contains(grandchildCard)).toBe(true)
    expect(childCard?.contains(parentCard)).toBe(false)

    expect(latestPropsFor(parent.id)?.lineageChildCount).toBe(1)
    expect(latestPropsFor(child.id)?.lineageChildCount).toBe(1)
    expect(latestPropsFor(grandchild.id)?.lineageChildCount).toBe(0)
  })

  it('marks only the active worktree card, including at nested depth', () => {
    const { parent, child, grandchild } = seedThreeLevelLineage()
    testState.store.activeWorktreeId = child.id

    renderPanel()

    expect(cardFor(child.id)?.getAttribute('data-active')).toBe('true')
    expect(cardFor(parent.id)?.getAttribute('data-active')).toBe('false')
    expect(cardFor(grandchild.id)?.getAttribute('data-active')).toBe('false')
  })

  it('suppresses click, double-click and drag start on the depth-two wrapper', () => {
    const { grandchild } = seedThreeLevelLineage()

    renderPanel()

    const grandchildCard = cardFor(grandchild.id)
    act(() => {
      grandchildCard?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      grandchildCard?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      grandchildCard?.dispatchEvent(new Event('dragstart', { bubbles: true }))
    })

    expect(testState.cardClicks).toEqual([grandchild.id])
    expect(testState.cardDoubleClicks).toEqual([grandchild.id])
    expect(testState.cardDragStarts).toEqual([grandchild.id])
  })

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

  it('renders both participants of an upstream-stripped cycle as roots', () => {
    const first = makeWorktree({
      id: 'repo-1::/cycle-a',
      displayName: 'Cycle A',
      instanceId: 'cycle-a-instance',
      lastActivityAt: 50
    })
    const second = makeWorktree({
      id: 'repo-1::/cycle-b',
      displayName: 'Cycle B',
      instanceId: 'cycle-b-instance',
      lastActivityAt: 10
    })
    testState.store.worktreesByRepo = { 'repo-1': [first, second] }
    testState.store.workspaceLineageByChildKey = {
      [first.id]: makeWorkspaceLineage(first, 'folder-1'),
      [second.id]: makeWorkspaceLineage(second, 'folder-1')
    }
    testState.store.worktreeLineageById = {
      [first.id]: makeWorktreeLineage(first, second),
      [second.id]: makeWorktreeLineage(second, first)
    }

    renderPanel()

    // Why: the lineage projection drops cyclic child ids upstream, so the panel only ever sees roots.
    const ids = renderedCardIds()
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([first.id, second.id])
    expect(cardFor(first.id)?.parentElement).toBe(cardFor(second.id)?.parentElement)
    expect(latestPropsFor(first.id)?.lineageChildCount).toBe(0)
    expect(latestPropsFor(second.id)?.lineageChildCount).toBe(0)
  })

  it('keeps a leaf sibling free of the deeper sibling subtree', () => {
    const root = makeWorktree({
      id: 'repo-1::/uneven-root',
      displayName: 'Uneven root',
      instanceId: 'uneven-root-instance',
      lastActivityAt: 90
    })
    const leafSibling = makeWorktree({
      id: 'repo-1::/leaf-sibling',
      displayName: 'Leaf sibling',
      instanceId: 'leaf-sibling-instance',
      lastActivityAt: 50
    })
    const deepSibling = makeWorktree({
      id: 'repo-1::/deep-sibling',
      displayName: 'Deep sibling',
      instanceId: 'deep-sibling-instance',
      lastActivityAt: 30
    })
    const deepChild = makeWorktree({
      id: 'repo-1::/deep-child',
      displayName: 'Deep child',
      instanceId: 'deep-child-instance',
      lastActivityAt: 10
    })
    testState.store.worktreesByRepo = { 'repo-1': [root, leafSibling, deepSibling, deepChild] }
    testState.store.workspaceLineageByChildKey = {
      [root.id]: makeWorkspaceLineage(root, 'folder-1')
    }
    testState.store.worktreeLineageById = {
      [leafSibling.id]: makeWorktreeLineage(leafSibling, root),
      [deepSibling.id]: makeWorktreeLineage(deepSibling, root),
      [deepChild.id]: makeWorktreeLineage(deepChild, deepSibling)
    }

    renderPanel()

    // Why: siblings sort by recent activity, so the leaf renders before the deeper sibling.
    const ids = renderedCardIds()
    expect(ids).toEqual([root.id, leafSibling.id, deepSibling.id, deepChild.id])
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      cardFor(leafSibling.id)?.querySelector(`[data-worktree-id="${deepChild.id}"]`)
    ).toBeNull()
    expect(
      cardFor(deepSibling.id)?.querySelector(`[data-worktree-id="${deepChild.id}"]`)
    ).not.toBeNull()
    expect(latestPropsFor(leafSibling.id)?.lineageChildCount).toBe(0)
    // Why: an empty array is truthy downstream, so a childless leaf must pass undefined.
    expect(latestPropsFor(leafSibling.id)?.lineageChildren).toBeUndefined()
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

  it('renders root cards straight into the list and nested cards inside a wrapper', () => {
    const { parent, child } = seedThreeLevelLineage()
    const siblingRoot = makeWorktree({
      id: 'repo-1::/sibling-root',
      displayName: 'Sibling root',
      instanceId: 'sibling-root-instance',
      lastActivityAt: 40
    })
    testState.store.worktreesByRepo['repo-1']?.push(siblingRoot)
    testState.store.workspaceLineageByChildKey[siblingRoot.id] = makeWorkspaceLineage(
      siblingRoot,
      'folder-1'
    )

    renderPanel()

    const parentCard = cardFor(parent.id)
    // Why: roots share the list container; only nested rows get their own suppression wrapper.
    expect(parentCard?.parentElement).toBe(cardFor(siblingRoot.id)?.parentElement)
    expect(cardFor(child.id)?.parentElement).not.toBe(parentCard)
    expect(cardFor(child.id)?.parentElement?.parentElement).toBe(parentCard)
  })

  it('pads legacy-style wrappers with the parent depth inset', () => {
    const { child, grandchild } = seedThreeLevelLineage()
    testState.store.settings = { experimentalNewWorktreeCardStyle: false }

    renderPanel()

    // Why: the wrapper inset is the parent's, so depth 1 gets none and depth 2 gets one step.
    expect(cardFor(child.id)?.parentElement?.getAttribute('style')).toBeNull()
    expect(cardFor(grandchild.id)?.parentElement?.style.paddingLeft).toBe('14px')
  })

  it('leaves experimental-style wrappers unpadded at every depth', () => {
    const { child, grandchild } = seedThreeLevelLineage()
    testState.store.settings = { experimentalNewWorktreeCardStyle: true }

    renderPanel()

    expect(cardFor(child.id)?.parentElement?.getAttribute('style')).toBeNull()
    expect(cardFor(grandchild.id)?.parentElement?.getAttribute('style')).toBeNull()
  })
})
