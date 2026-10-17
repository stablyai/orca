/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  RepoHeaderProjectActionsMenu,
  type RepoHeaderProjectActions
} from './repo-header-project-actions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button type="button" data-menu-item="" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button" data-menu-sub-trigger="">
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => children
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
})

function repoFixture(overrides: Partial<Repo>): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the menu reads only the fields set here.
  return {
    id: 'repo-1',
    path: '/home/me/app',
    displayName: 'app',
    kind: 'folder',
    projectGroupId: null,
    connectionId: null,
    ...overrides
  } as Repo
}

function groupFixture(overrides: Partial<ProjectGroup>): ProjectGroup {
  return {
    id: 'group',
    name: 'Group',
    parentPath: null,
    connectionId: null,
    executionHostId: 'local',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const PROJECT_GROUPS = [
  groupFixture({ id: 'mac-group', name: 'Mac projects', executionHostId: 'local' }),
  groupFixture({ id: 'linux-group', name: 'Linux projects', executionHostId: 'runtime:linux-env' }),
  groupFixture({
    id: 'mac-ssh-root-group',
    name: 'Router folders',
    connectionId: 'router',
    executionHostId: 'ssh:router'
  })
]

function renderMenu(repo: Repo, onMoveProjectToGroup = vi.fn()): HTMLDivElement {
  const actions: RepoHeaderProjectActions = {
    getWorktreeVisibilityDefaults: () => undefined,
    onOpenRepoSettings: vi.fn(),
    onOpenWorktreeVisibility: vi.fn(),
    onCreateGroupFromRepo: vi.fn(),
    onMoveProjectToGroup,
    onRemoveProjectFromGroup: vi.fn(),
    onRemoveProject: vi.fn(),
    onCreateForRepo: vi.fn()
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  act(() => {
    root.render(
      <RepoHeaderProjectActionsMenu
        repo={repo}
        label={repo.displayName}
        projectGroups={PROJECT_GROUPS}
        actions={actions}
      />
    )
  })
  return container
}

function groupItemLabels(container: HTMLElement): string[] {
  const groupNames = new Set(PROJECT_GROUPS.map((group) => group.name))
  return Array.from(container.querySelectorAll<HTMLElement>('[data-menu-item]'))
    .map((element) => element.textContent ?? '')
    .filter((label) => groupNames.has(label))
}

describe('RepoHeaderProjectActionsMenu Move to group', () => {
  it('offers a paired-host project only the groups on that host', () => {
    const onMoveProjectToGroup = vi.fn()
    const repo = repoFixture({ executionHostId: 'runtime:linux-env' })
    const container = renderMenu(repo, onMoveProjectToGroup)

    expect(groupItemLabels(container)).toEqual(['Linux projects'])
    const linuxItem = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-menu-item]')
    ).find((element) => element.textContent === 'Linux projects')
    act(() => linuxItem?.click())
    expect(onMoveProjectToGroup).toHaveBeenCalledWith(repo, 'linux-group')
  })

  it("offers this app's groups to its local and direct-SSH projects", () => {
    expect(groupItemLabels(renderMenu(repoFixture({ executionHostId: 'local' })))).toEqual([
      'Mac projects',
      'Router folders'
    ])
    expect(
      groupItemLabels(
        renderMenu(repoFixture({ connectionId: 'router', executionHostId: 'ssh:router' }))
      )
    ).toEqual(['Mac projects', 'Router folders'])
  })

  it('hides Move to group when no group lives on the project host', () => {
    const container = renderMenu(repoFixture({ executionHostId: 'runtime:other-env' }))

    expect(container.querySelector('[data-menu-sub-trigger]')).toBeNull()
    expect(groupItemLabels(container)).toEqual([])
  })
})
