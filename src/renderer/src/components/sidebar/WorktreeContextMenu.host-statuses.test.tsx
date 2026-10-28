/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorktreeContextMenu from './WorktreeContextMenu'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const state = {
  unifiedTabsByWorktree: {},
  updateWorktreeMeta: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn(),
  workspaceStatuses: [
    { id: 'in-progress', label: 'In progress' },
    { id: 'todo', label: 'Todo' }
  ],
  hostWorkspaceStatuses: { 'env-1': [{ id: 'status-6', label: '🔥 今天收尾' }] },
  removedRuntimeEnvironmentIds: new Set<string>(),
  openModal: vi.fn(),
  projectGroups: [],
  createProjectGroup: vi.fn(),
  moveProjectToGroup: vi.fn(),
  deleteStateByWorktreeId: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  updateWorktreeLineage: vi.fn(),
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  browserTabsByWorktree: {},
  keybindings: {},
  settings: { activeRuntimeEnvironmentId: null, openInApplications: [] },
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  workspaceViews: []
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [],
  useRepoById: (repoId?: string) =>
    repoId ? { id: repoId, name: repoId, displayName: repoId, projectGroupId: null } : undefined,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en', on: () => {}, off: () => {} }
}))

vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))

type StatusMenuCapture = {
  contextWorkspaceStatus: string
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}
const statusMenu = vi.hoisted(() => {
  const capture: { current: StatusMenuCapture | null } = { current: null }
  return capture
})
vi.mock('./WorktreeStatusMenuItems', () => ({
  WorktreeStatusMenuItems: (props: StatusMenuCapture) => {
    statusMenu.current = props
    return null
  }
}))
vi.mock('./WorktreeOpenInMenu', () => ({ WorktreeOpenInSubMenu: () => null }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
  statusMenu.current = null
})

function openMenu(worktree: Worktree): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  act(() => {
    root.render(
      <TooltipProvider>
        <WorktreeContextMenu worktree={worktree}>
          <div>Card</div>
        </WorktreeContextMenu>
      </TooltipProvider>
    )
  })
  const scope = container.querySelector('[data-worktree-context-menu-scope]')
  act(() => {
    scope?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
}

describe('WorktreeContextMenu Move to Status for a paired host card', () => {
  it("offers the host's own column and marks it current instead of the default", () => {
    openMenu(
      makeWorktree({
        id: 'repo::wt-1',
        repoId: 'repo',
        hostId: toRuntimeExecutionHostId('env-1'),
        displayName: 'Today',
        branch: 'refs/heads/today',
        path: '/today',
        workspaceStatus: 'status-6'
      })
    )

    expect(statusMenu.current?.workspaceStatuses.map((status) => status.id)).toEqual([
      'in-progress',
      'todo',
      'status-6'
    ])
    expect(statusMenu.current?.contextWorkspaceStatus).toBe('status-6')
  })

  it("offers a local card only the local columns, not a paired host's", () => {
    openMenu(makeWorktree({ id: 'repo::wt-2', repoId: 'repo', path: '/local' }))

    expect(statusMenu.current?.workspaceStatuses.map((status) => status.id)).toEqual([
      'in-progress',
      'todo'
    ])
  })
})
