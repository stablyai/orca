import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
    DropdownMenuTrigger: Passthrough
  }
})

vi.mock('lucide-react', async () =>
  (await import('../../../tab-bar/lucide-icon-stub-fixture')).stubEveryIcon()
)

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback
      .replace('{{hostLabel}}', String(values?.hostLabel ?? ''))
      .replace('{{value0}}', String(values?.value0 ?? ''))
}))

const { RepoHeaderProjectActionsMenu } = await import('./repo-header-project-actions')
const { getProjectGroupMenuHostLabel } = await import('../../project-group-menu-label')

const repo: Repo = {
  id: 'tooling',
  path: '/work/tooling',
  displayName: 'tooling',
  badgeColor: '#111',
  addedAt: 1,
  executionHostId: 'runtime:work'
}

function group(id: string, name: string, executionHostId: ExecutionHostId): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  }
}

function actions() {
  return {
    getWorktreeVisibilityDefaults: vi.fn(),
    onOpenRepoSettings: vi.fn(),
    onOpenWorktreeVisibility: vi.fn(),
    onCreateGroupFromRepo: vi.fn(),
    onMoveProjectToGroup: vi.fn(),
    onRemoveProjectFromGroup: vi.fn(),
    onRemoveProject: vi.fn(),
    onCreateForRepo: vi.fn()
  }
}

describe('repository project-group menu host context', () => {
  it('names the owning Orca remote and excludes groups from another remote', () => {
    const projectGroups = [
      group('work-group', 'Work Group', 'runtime:work'),
      group('home-group', 'Home Group', 'runtime:home')
    ]
    const markup = renderToStaticMarkup(
      <RepoHeaderProjectActionsMenu
        repo={repo}
        label="tooling"
        projectGroupHostLabel={getProjectGroupMenuHostLabel(repo, true, 'Work')}
        projectGroups={projectGroups}
        actions={actions()}
      />
    )

    expect(markup).toContain('Move to group: Work')
    expect(markup).toContain('Work Group')
    expect(markup).not.toContain('Home Group')
  })

  it('keeps the generic label for local projects', () => {
    const localRepo = { ...repo, executionHostId: 'local' as const }
    const projectGroups = [group('local-group', 'Local Group', 'local')]
    const markup = renderToStaticMarkup(
      <RepoHeaderProjectActionsMenu
        repo={localRepo}
        label="tooling"
        projectGroupHostLabel={getProjectGroupMenuHostLabel(localRepo, false)}
        projectGroups={projectGroups}
        actions={actions()}
      />
    )

    expect(markup).toContain('Move to group')
    expect(markup).not.toContain('Move to group:')
  })

  it('names the local catalog when local and remote groups coexist', () => {
    const localRepo = { ...repo, executionHostId: 'local' as const }
    const projectGroups = [
      group('local-group', 'Local Group', 'local'),
      group('work-group', 'Work Group', 'runtime:work')
    ]
    const markup = renderToStaticMarkup(
      <RepoHeaderProjectActionsMenu
        repo={localRepo}
        label="tooling"
        projectGroupHostLabel={getProjectGroupMenuHostLabel(localRepo, true)}
        projectGroups={projectGroups}
        actions={actions()}
      />
    )

    expect(markup).toContain('Move to group: Local')
    expect(markup).toContain('Local Group')
    expect(markup).not.toContain('Work Group')
  })

  it('keeps the generic label when only one remote catalog exists', () => {
    const projectGroups = [group('work-group', 'Work Group', 'runtime:work')]
    const markup = renderToStaticMarkup(
      <RepoHeaderProjectActionsMenu
        repo={repo}
        label="tooling"
        projectGroupHostLabel={getProjectGroupMenuHostLabel(repo, false, 'Work')}
        projectGroups={projectGroups}
        actions={actions()}
      />
    )

    expect(markup).toContain('Move to group')
    expect(markup).not.toContain('Move to group:')
  })
})
