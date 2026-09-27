// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { useWorktreeContextMenuModel } from './use-worktree-context-menu-model'
import * as deleteLineage from './workspace-delete-lineage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const lineageById: Record<string, WorktreeLineage> = {}
let worktrees: Worktree[] = []
let worktreeMap = new Map<string, Worktree>()

const state = {
  updateWorktreeMeta: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn(),
  workspaceStatuses: [],
  openModal: vi.fn(),
  projectGroups: [],
  createProjectGroup: vi.fn(),
  moveProjectToGroup: vi.fn(),
  deleteStateByWorktreeId: {},
  worktreeLineageById: lineageById,
  workspaceLineageByChildKey: {},
  updateWorktreeLineage: vi.fn(),
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  browserTabsByWorktree: {},
  keybindings: {},
  settings: { activeRuntimeEnvironmentId: null, openInApplications: [] },
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => worktrees,
  useRepoById: (repoId?: string) =>
    repoId ? { id: repoId, name: repoId, displayName: repoId, projectGroupId: null } : undefined,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => worktreeMap
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en', on: () => {}, off: () => {} }
}))

vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))

function makeWorktree(id: string): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: 'repo-1',
    path: `/workspaces/${id}`,
    head: 'abc123',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

afterEach(() => vi.restoreAllMocks())

it('skips closed-menu lineage scans and reads current descendants on opening', () => {
  const parent = makeWorktree('parent')
  const child = makeWorktree('child')
  const grandchild = makeWorktree('grandchild')
  const inlineChild = { ...child, lineage: makeLineage(child, parent) }
  worktrees = [parent, inlineChild]
  worktreeMap = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  state.worktreeLineageById = { [child.id]: makeLineage(child, parent) }
  const scan = vi.spyOn(deleteLineage, 'getWorkspaceDeleteLineage')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function Harness() {
    const model = useWorktreeContextMenuModel({ worktree: parent, children: null })
    return (
      <button onClick={() => model.setMenuOpenState(!model.menuOpen)}>
        {model.lineageDescendantCount}
      </button>
    )
  }
  const render = () => act(() => root.render(<Harness />))
  try {
    render()
    expect(scan).not.toHaveBeenCalled()
    worktrees = [parent, inlineChild, grandchild]
    worktreeMap = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
    state.worktreeLineageById = {
      [child.id]: makeLineage(child, parent),
      [grandchild.id]: makeLineage(grandchild, child)
    }
    render()
    expect(scan).not.toHaveBeenCalled()
    const button = container.querySelector('button')!
    act(() => button.click())
    expect(scan).toHaveBeenCalledOnce()
    expect(button.textContent).toBe('2')
    state.worktreeLineageById = { [child.id]: makeLineage(child, parent) }
    render()
    expect(button.textContent).toBe('1')
    act(() => button.click())
    expect(button.textContent).toBe('1')
    scan.mockClear()
    worktrees = [...worktrees]
    render()
    expect(scan).toHaveBeenCalledOnce()
    expect(button.textContent).toBe('1')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
