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
    unifiedTabsByWorktree: {},
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

// Like the real id-keyed selector for a repo id shared by two hosts: it returns one of the rows.
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

function openContextMenu(worktree: Worktree): void {
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
}

function chooseGroup(worktree: Worktree, groupName: string): void {
  openContextMenu(worktree)
  const trigger = menuItem('Move to group')
  act(() => {
    trigger?.focus()
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  const item = menuItem(groupName)
  act(() => {
    item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item?.click()
  })
}

describe('WorktreeContextMenu project row across hosts', () => {
  it("moves the clicked workspace's own row when two hosts share its repo id", () => {
    state.repos = [repoRow('app', 'local'), repoRow('app', 'runtime:linux-env')]

    chooseGroup(worktreeFixture({ hostId: 'runtime:linux-env' }), 'Linux projects')

    expect(state.moveProjectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app', executionHostId: 'runtime:linux-env' }),
      'linux-group'
    )
  })

  it('keeps an unstamped local workspace on this Mac while a paired twin is listed first', () => {
    // The mocked id-keyed selector returns the first row: the paired twin.
    state.repos = [repoRow('app', 'runtime:linux-env'), repoRow('app', 'local')]

    chooseGroup(worktreeFixture(), 'Mac projects')

    expect(state.moveProjectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app', executionHostId: 'local' }),
      'mac-group'
    )
  })

  it("shows Remove from group from the clicked workspace's own row", () => {
    state.repos = [
      repoRow('app', 'local'),
      { ...repoRow('app', 'runtime:linux-env'), projectGroupId: 'linux-group' }
    ]

    openContextMenu(worktreeFixture({ hostId: 'runtime:linux-env' }))

    expect(menuItem('Remove from group')).toBeDefined()
  })

  it("keeps an unshared repo id's only row for a workspace without a host stamp", () => {
    state.repos = [{ ...repoRow('app', 'ssh:build-box'), projectGroupId: 'linux-group' }]

    openContextMenu(worktreeFixture())

    expect(menuItem('Remove from group')).toBeDefined()
  })
})
