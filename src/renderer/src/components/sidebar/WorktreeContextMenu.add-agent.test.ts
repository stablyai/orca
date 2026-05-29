import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactTypes from 'react'
import type { Worktree } from '../../../../shared/types'
import WorktreeContextMenu from './WorktreeContextMenu'

const { activateAndRevealWorktreeMock, focusTerminalTabSurfaceMock, mockRepo, mockState } =
  vi.hoisted(() => {
    const repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: null as string | null
    }
    return {
      activateAndRevealWorktreeMock: vi.fn(),
      focusTerminalTabSurfaceMock: vi.fn(),
      mockRepo: repo,
      mockState: {
        updateWorktreeMeta: vi.fn(),
        workspaceStatuses: [{ id: 'active', label: 'Active' }],
        openModal: vi.fn(),
        projectGroups: [],
        createProjectGroup: vi.fn(),
        moveProjectToGroup: vi.fn(),
        deleteStateByWorktreeId: {},
        worktreeLineageById: {},
        updateWorktreeLineage: vi.fn(),
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: {},
        repos: [repo],
        worktreesByRepo: {} as Record<string, Worktree[]>
      }
    }
  })

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactTypes>('react')
  return {
    ...actual,
    memo: <T>(component: T) => component,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: () => {},
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(current: T) => ({ current }),
    useState: <T>(initial: T) => [initial, vi.fn()] as const
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mockState) => unknown) => selector(mockState)
}))

vi.mock('@/store/selectors', () => ({
  useRepoById: () => mockRepo,
  useRepoMap: () => new Map([[mockRepo.id, mockRepo]]),
  useWorktreeMap: () =>
    new Map(
      Object.values(mockState.worktreesByRepo)
        .flat()
        .map((worktree) => [worktree.id, worktree])
    )
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusTerminalTabSurfaceMock
}))

vi.mock('./worktree-list-groups', () => ({
  getLineageRenderInfo: () => ({ state: 'none' })
}))

vi.mock('./workspace-status', () => ({
  getWorkspaceStatus: () => 'active',
  getWorkspaceStatusVisualMeta: () => ({
    icon: function StatusIcon() {
      return null
    },
    tone: ''
  })
}))

type ReactElementLike = {
  type: unknown
  props?: Record<string, unknown>
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: mockRepo.id,
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Workspace 1',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdWithAgent: undefined,
    ...overrides
  }
}

function typeName(type: unknown): string | null {
  if (typeof type === 'string') {
    return type
  }
  return typeof type === 'function' ? type.name : null
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'boolean') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((child) => visit(child, cb))
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return
  }
  const element = node as ReactElementLike
  cb(element)
  visit(element.props?.children, cb)
}

function containsText(node: unknown, text: string): boolean {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).includes(text)
  }
  if (node == null || typeof node === 'boolean') {
    return false
  }
  if (Array.isArray(node)) {
    return node.some((child) => containsText(child, text))
  }
  return containsText((node as ReactElementLike).props?.children, text)
}

function findQuickLaunchItem(node: unknown): ReactElementLike | null {
  let match: ReactElementLike | null = null
  visit(node, (element) => {
    if (element.props?.launchSource === 'sidebar') {
      match = element
    }
  })
  return match
}

function renderMenu(worktree: Worktree, selectedWorktrees: readonly Worktree[] = [worktree]) {
  const candidate = WorktreeContextMenu as unknown as
    | ((props: Record<string, unknown>) => unknown)
    | { type: (props: Record<string, unknown>) => unknown }
  const Component = typeof candidate === 'function' ? candidate : candidate.type
  return Component({ worktree, selectedWorktrees, children: 'workspace row' })
}

function placementTokens(node: unknown): string[] {
  const tokens: string[] = []
  visit(node, (element) => {
    const name = typeName(element.type)
    if (name === 'WorktreeOpenInSubMenu') {
      tokens.push('open-in')
    } else if (
      name === 'DropdownMenuSubTrigger' &&
      containsText(element.props?.children, 'Add Agent')
    ) {
      tokens.push('add-agent')
    } else if (name === 'DropdownMenuItem' && containsText(element.props?.children, 'Copy Path')) {
      tokens.push('copy-path')
    }
  })
  return tokens
}

beforeEach(() => {
  activateAndRevealWorktreeMock.mockReset()
  focusTerminalTabSurfaceMock.mockReset()
  mockState.updateWorktreeMeta = vi.fn()
  mockState.openModal = vi.fn()
  mockState.projectGroups = []
  mockState.createProjectGroup = vi.fn()
  mockState.moveProjectToGroup = vi.fn()
  mockState.deleteStateByWorktreeId = {}
  mockState.worktreeLineageById = {}
  mockState.updateWorktreeLineage = vi.fn()
  mockState.tabsByWorktree = {}
  mockState.ptyIdsByTabId = {}
  mockState.browserTabsByWorktree = {}
  mockState.worktreesByRepo = {}
})

describe('WorktreeContextMenu Add Agent submenu', () => {
  it('places Add Agent between Open in and Copy Path for a single workspace', () => {
    const worktree = makeWorktree()
    mockState.worktreesByRepo = { [mockRepo.id]: [worktree] }

    const tree = renderMenu(worktree)
    const placement = placementTokens(tree)
    const openInIndex = placement.indexOf('open-in')
    const addAgentIndex = placement.indexOf('add-agent')
    const copyPathIndex = placement.indexOf('copy-path')

    expect(openInIndex).toBeGreaterThanOrEqual(0)
    expect(addAgentIndex).toBeGreaterThan(openInIndex)
    expect(copyPathIndex).toBeGreaterThan(addAgentIndex)

    const quickLaunch = findQuickLaunchItem(tree)
    expect(quickLaunch?.props).toMatchObject({
      worktreeId: worktree.id,
      groupId: worktree.id,
      launchSource: 'sidebar',
      onFocusTerminal: focusTerminalTabSurfaceMock
    })

    const onBeforeLaunch = quickLaunch?.props?.onBeforeLaunch as (() => void) | undefined
    onBeforeLaunch?.()
    expect(activateAndRevealWorktreeMock).toHaveBeenCalledWith(worktree.id, {
      skipInitialTerminal: true
    })
  })

  it('hides Add Agent when the context menu targets multiple workspaces', () => {
    const first = makeWorktree()
    const second = makeWorktree({ id: 'wt-2', path: '/repo/wt-2', displayName: 'Workspace 2' })
    mockState.worktreesByRepo = { [mockRepo.id]: [first, second] }

    const tree = renderMenu(first, [first, second])

    expect(findQuickLaunchItem(tree)).toBeNull()
    expect(containsText(tree, 'Add Agent')).toBe(false)
  })
})
