// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { ProjectGroupHeaderMenu } from './project-group-header-actions'
import { useProjectGroupDialogs, type ProjectGroupDialogs } from './use-project-group-dialogs'

type MenuItemProps = { children?: ReactNode; onSelect?: () => void }

const menuItems = vi.hoisted((): { values: MenuItemProps[] } => ({
  values: []
}))
const mocks = vi.hoisted(() => ({
  moveProjectToGroup: vi.fn(),
  createProjectGroup: vi.fn(),
  updateProjectGroup: vi.fn(),
  deleteProjectGroupWithContainedProjects: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuItem: (props: MenuItemProps) => {
      menuItems.values.push(props)
      return React_.createElement(React_.Fragment, null, props.children)
    }
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      moveProjectToGroup: mocks.moveProjectToGroup,
      createProjectGroup: mocks.createProjectGroup,
      updateProjectGroup: mocks.updateProjectGroup,
      deleteProjectGroupWithContainedProjects: mocks.deleteProjectGroupWithContainedProjects
    })
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const PARENT: ProjectGroup = {
  id: 'parent',
  name: 'Client Work',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  claudeConfigDir: '/home/alice/.claude-client',
  createdAt: 1,
  updatedAt: 1
}
const CHILD: ProjectGroup = {
  ...PARENT,
  id: 'child',
  name: 'Child',
  parentGroupId: 'parent'
}

const UNBOUND_CHILD: ProjectGroup = { ...CHILD, claudeConfigDir: null }

let latest: ProjectGroupDialogs | null = null
const roots: Root[] = []

function HookProbe(): null {
  latest = useProjectGroupDialogs({
    repos: [],
    repoMap: new Map(),
    projectGroups: [PARENT, UNBOUND_CHILD]
  })
  return null
}

async function renderHookProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<HookProbe />)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  menuItems.values = []
  latest = null
  mocks.updateProjectGroup.mockResolvedValue(true)
})

afterEach(() => {
  act(() => {
    roots.splice(0).forEach((root) => root.unmount())
  })
})

describe('ProjectGroupHeaderMenu group settings item', () => {
  it('renders a settings item beside rename and delete', () => {
    const markup = renderToStaticMarkup(
      <ProjectGroupHeaderMenu
        groupId="child"
        hostId="runtime:env-1"
        label="Child"
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )

    expect(markup).toContain('Group settings')
    expect(markup).toContain('Rename group')
    expect(markup).toContain('Delete group')
  })

  it("opens settings for the row's own group and owner host", () => {
    const onOpenSettings = vi.fn()
    renderToStaticMarkup(
      <ProjectGroupHeaderMenu
        groupId="child"
        hostId="runtime:env-1"
        label="Child"
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onOpenSettings={onOpenSettings}
      />
    )

    const settingsItem = menuItems.values.find((item) => item.children === 'Group settings…')
    settingsItem?.onSelect?.()

    expect(onOpenSettings).toHaveBeenCalledWith('child', 'runtime:env-1')
  })
})

describe('useProjectGroupDialogs settings flow', () => {
  it("opens the dialog with the group's own binding and the inherited ancestor", async () => {
    await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('child')
    })

    expect(latest?.settingsDialog).toMatchObject({
      groupId: 'child',
      configDir: null
    })
    expect(latest?.settingsDialog?.inherited).toEqual({
      configDir: '/home/alice/.claude-client',
      groupId: 'parent',
      groupName: 'Client Work'
    })
  })

  it('writes null through updateProjectGroup when the binding is cleared', async () => {
    await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('child', 'runtime:env-1')
    })
    await act(async () => {
      await latest?.handleSubmitProjectGroupSettings(null)
    })

    expect(mocks.updateProjectGroup).toHaveBeenCalledWith(
      'child',
      { claudeConfigDir: null },
      { hostId: 'runtime:env-1' }
    )
  })

  it('reports a refused write instead of leaving the dialog looking saved', async () => {
    mocks.updateProjectGroup.mockResolvedValue(false)
    await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('child')
    })
    await act(async () => {
      await latest?.handleSubmitProjectGroupSettings('.claude')
    })

    expect(mocks.toastError).toHaveBeenCalled()
  })
})
