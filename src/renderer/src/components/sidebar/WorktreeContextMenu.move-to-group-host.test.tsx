/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorktreeContextMenu from './WorktreeContextMenu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function repoRow(id: string, executionHostId: string): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the menu reads only the fields set here.
  return {
    id,
    path: `/projects/${id}`,
    displayName: id,
    projectGroupId: null,
    connectionId: null,
    executionHostId
  } as Repo
}

const state = vi.hoisted(() => {
  const repos: Repo[] = []
  return {
    repos,
    updateWorktreeMeta: vi.fn(),
    setWorktreesPinnedAndReveal: vi.fn(),
    workspaceStatuses: [],
    openModal: vi.fn(),
    projectGroups: [
      { id: 'mac-group', name: 'Mac projects', connectionId: null, executionHostId: 'local' },
      {
        id: 'linux-group',
        name: 'Linux projects',
        connectionId: null,
        executionHostId: 'runtime:linux-env'
      }
    ],
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
    openSettingsTarget: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

// Like the real selector for a repo id shared by two hosts while this Mac's workspace is active.
vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [],
  useRepoById: (repoId?: string) => state.repos.find((repo) => repo.id === repoId) ?? null,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en', on: () => {}, off: () => {} }
}))

vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))
vi.mock('./WorktreeOpenInMenu', () => ({ WorktreeOpenInSubMenu: () => null }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
  state.moveProjectToGroup.mockReset()
})

function worktreeFixture(overrides: Partial<Worktree> = {}): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the menu reads only the fields set here.
  return {
    id: 'app::/home/me/app',
    repoId: 'app',
    displayName: 'app',
    branch: 'refs/heads/main',
    path: '/home/me/app',
    isMainWorktree: true,
    ...overrides
  } as Worktree
}

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (element) => element.textContent === label
  )
}

function openMoveToGroupSubmenu(worktree: Worktree): string[] {
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
  act(() => {
    container
      .querySelector('[data-worktree-context-menu-scope]')
      ?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
  })
  const trigger = menuItem('Move to group')
  if (!trigger) {
    return []
  }
  act(() => {
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .map((element) => element.textContent ?? '')
    .filter((label) => label === 'Mac projects' || label === 'Linux projects')
}

describe('WorktreeContextMenu Move to group across hosts', () => {
  it("offers only groups the project's own host can hold", () => {
    state.repos = [repoRow('app', 'runtime:linux-env')]

    expect(openMoveToGroupSubmenu(worktreeFixture({ hostId: 'runtime:linux-env' }))).toEqual([
      'Linux projects'
    ])
  })

  it('hides the submenu when no group lives on the project host', () => {
    state.repos = [repoRow('app', 'runtime:other-env')]

    expect(openMoveToGroupSubmenu(worktreeFixture({ hostId: 'runtime:other-env' }))).toEqual([])
    expect(menuItem('Move to group')).toBeUndefined()
  })

  it("uses the clicked workspace's own row when two hosts share its repo id", () => {
    state.repos = [repoRow('app', 'local'), repoRow('app', 'runtime:linux-env')]

    expect(openMoveToGroupSubmenu(worktreeFixture({ hostId: 'runtime:linux-env' }))).toEqual([
      'Linux projects'
    ])
    const linuxItem = menuItem('Linux projects')
    act(() => {
      linuxItem?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      linuxItem?.click()
    })
    expect(state.moveProjectToGroup).toHaveBeenCalledWith(
      'app',
      'linux-group',
      undefined,
      'runtime:linux-env'
    )
  })
})
