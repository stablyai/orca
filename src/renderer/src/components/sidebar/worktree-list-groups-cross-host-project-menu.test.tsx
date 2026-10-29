/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RepoHeaderProjectActionsMenu,
  type RepoHeaderProjectActions
} from './worktree-list/rows/repo-header-project-actions'
import { project } from './worktree-list-groups-test-fixtures'
import {
  localGroup,
  localRepo,
  pairedGroup,
  pairedHostId,
  pairedRepo,
  planRows,
  THIS_ORCA_ORDER
} from './worktree-list-groups-cross-host-project-group.test-fixture'
import type { ProjectGroup } from '../../../../shared/project-group-types'

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
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => children,
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

// A second group on the paired host, so a move has somewhere that host's row can go.
const otherPairedGroup: ProjectGroup = {
  ...pairedGroup,
  id: 'group-b',
  name: 'Laptop B',
  tabOrder: 2
}

function actionsFixture(): RepoHeaderProjectActions {
  return {
    getWorktreeVisibilityDefaults: () => undefined,
    onOpenRepoSettings: vi.fn(),
    onOpenWorktreeVisibility: vi.fn(),
    onCreateGroupFromRepo: vi.fn(),
    onMoveProjectToGroup: vi.fn(),
    onRemoveProjectFromGroup: vi.fn(),
    onRemoveProject: vi.fn(),
    onCreateForRepo: vi.fn()
  }
}

// This Orca anchors the header on its own ungrouped row; the paired row puts it in the group.
function renderPlannedProjectMenu(actions: RepoHeaderProjectActions): HTMLDivElement {
  const groups = [pairedGroup, otherPairedGroup, localGroup]
  const header = planRows({ repoOrder: THIS_ORCA_ORDER, groups })
    .render(new Set())
    .find((row) => row.type === 'header' && row.key === `project:${project.id}`)
  if (header?.type !== 'header' || !header.repo) {
    throw new Error('expected the merged project header')
  }
  const { repo, projectGroupRepo } = header
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  // Same props SectionHeader passes for a project header.
  act(() =>
    root.render(
      <RepoHeaderProjectActionsMenu
        repo={repo}
        projectGroupRepo={projectGroupRepo}
        label="orca"
        projectGroups={groups}
        actions={actions}
      />
    )
  )
  return container
}

function menuItem(container: HTMLDivElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-menu-item]')).find(
    (item) => item.textContent?.trim() === label
  )
}

describe('the project menu of a header drawn in a group through the paired host row', () => {
  it('offers Remove from group and removes the paired host row', () => {
    const actions = actionsFixture()
    const container = renderPlannedProjectMenu(actions)

    expect(localRepo.projectGroupId).toBeNull()
    act(() => menuItem(container, 'Remove from group')?.click())

    expect(actions.onRemoveProjectFromGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: pairedRepo.id, executionHostId: pairedHostId })
    )
  })

  it('moves the paired host row and marks the group it is drawn in as current', () => {
    const actions = actionsFixture()
    const container = renderPlannedProjectMenu(actions)

    expect(menuItem(container, pairedGroup.name)?.disabled).toBe(true)
    act(() => menuItem(container, otherPairedGroup.name)?.click())

    expect(actions.onMoveProjectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: pairedRepo.id, executionHostId: pairedHostId }),
      otherPairedGroup.id
    )
  })

  it("moves this Orca's row into this Orca's group, which the paired row cannot join", () => {
    const actions = actionsFixture()
    const container = renderPlannedProjectMenu(actions)

    act(() => menuItem(container, localGroup.name)?.click())

    expect(actions.onMoveProjectToGroup).toHaveBeenCalledWith(localRepo, localGroup.id)
  })

  it("keeps the other project actions on this Orca's anchor row", () => {
    const actions = actionsFixture()
    const container = renderPlannedProjectMenu(actions)

    act(() => menuItem(container, 'Project Settings')?.click())
    act(() => menuItem(container, 'Remove Project')?.click())

    expect(actions.onOpenRepoSettings).toHaveBeenCalledWith(localRepo.id)
    expect(actions.onRemoveProject).toHaveBeenCalledWith(localRepo)
  })
})
