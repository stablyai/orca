/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorktreeContextMenu from './WorktreeContextMenu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const state = {
  updateWorktreeMeta: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn(),
  workspaceStatuses: [],
  openModal: vi.fn(),
  projectGroups: [],
  createProjectGroup: vi.fn(),
  moveProjectToGroup: vi.fn(),
  deleteStateByWorktreeId: {},
  worktreeLineageById: {} as Record<string, WorktreeLineage>,
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

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

beforeEach(() => {
  state.worktreeLineageById = {}
  state.updateWorktreeLineage = vi.fn().mockResolvedValue(undefined)
})

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
})

function row(id: string): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the menu reads only the fields set here.
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: 'repo',
    displayName: id,
    branch: `refs/heads/${id}`,
    path: `/path/to/${id}`,
    isMainWorktree: false
  } as Worktree
}

function worktreeLineage(childId: string, parentId: string): WorktreeLineage {
  return {
    worktreeId: childId,
    worktreeInstanceId: `${childId}-instance`,
    parentWorktreeId: parentId,
    parentWorktreeInstanceId: `${parentId}-instance`,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function openMenu(selected: readonly Worktree[]): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  act(() => {
    root.render(
      <TooltipProvider>
        <WorktreeContextMenu worktree={selected[0]} selectedWorktrees={selected}>
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

function findMenuItem(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (element) => element.textContent === label
  )
}

describe('WorktreeContextMenu bulk Remove from Parent', () => {
  it('hides the bulk item when a parent is selected together with its only linked child', () => {
    state.worktreeLineageById = {
      'repo::child': worktreeLineage('repo::child', 'repo::parent')
    }

    openMenu([row('repo::parent'), row('repo::child')])

    expect(document.querySelectorAll('[role="menuitem"]').length, 'menu opened').toBeGreaterThan(0)
    expect(findMenuItem('Remove from Parent')).toBeUndefined()
  })

  it('shows the bulk item and detaches only the row linked outside the selection', () => {
    state.worktreeLineageById = {
      'repo::child': worktreeLineage('repo::child', 'repo::outside')
    }

    openMenu([row('repo::top'), row('repo::child')])

    const item = findMenuItem('Remove from Parent')
    expect(item, 'menu item "Remove from Parent"').toBeTruthy()
    // Why: the menu swallows clicks until a primary pointerdown proves they aren't the opening right-click.
    act(() => {
      item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      item?.click()
    })

    expect(state.updateWorktreeLineage).toHaveBeenCalledExactlyOnceWith('repo::child', {
      noParent: true
    })
  })
})
