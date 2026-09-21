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
// Ownership carried only by executionHostId — project-group-owner-stamping leaves connectionId null.
const REMOTE_CHILD: ProjectGroup = {
  ...UNBOUND_CHILD,
  id: 'remote-child',
  executionHostId: 'runtime:env-1'
}

const DEFAULT_GROUPS: readonly ProjectGroup[] = [PARENT, UNBOUND_CHILD, REMOTE_CHILD]

let latest: ProjectGroupDialogs | null = null
const roots: Root[] = []

function HookProbe({ groups }: { groups: readonly ProjectGroup[] }): null {
  latest = useProjectGroupDialogs({
    repos: [],
    repoMap: new Map(),
    projectGroups: groups
  })
  return null
}

async function renderHookProbe(
  groups: readonly ProjectGroup[] = DEFAULT_GROUPS
): Promise<(next: readonly ProjectGroup[]) => Promise<void>> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<HookProbe groups={groups} />)
  })
  return async (next) => {
    await act(async () => {
      root.render(<HookProbe groups={next} />)
    })
  }
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

    expect(latest?.settingsDialog).toMatchObject({ groupId: 'child' })
    expect(latest?.settingsTarget).toMatchObject({
      groupName: 'Child',
      configDir: null,
      executionHostId: 'local'
    })
    expect(latest?.settingsTarget?.inherited).toEqual({
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
    let saved: boolean | undefined

    act(() => {
      latest?.handleOpenProjectGroupSettings('child')
    })
    await act(async () => {
      saved = await latest?.handleSubmitProjectGroupSettings('.claude')
    })

    expect(mocks.toastError).toHaveBeenCalled()
    expect(saved).toBe(false)
  })

  it("stamps the dialog with the group row's resolved execution host, not its legacy field", async () => {
    await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('remote-child', 'runtime:env-1')
    })

    expect(latest?.settingsTarget?.executionHostId).toBe('runtime:env-1')
  })

  // N1: the host-stamped row cannot be resolved without its hostId, and `local` is the one answer
  // that silently points the probe, the folder picker and the save at the wrong filesystem.
  it('refuses to open a row whose owner host cannot be resolved instead of assuming local', async () => {
    await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('remote-child')
    })

    expect(latest?.settingsDialog).toBeNull()
    expect(latest?.settingsTarget).toBeNull()
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('refuses a group id that is in no catalog at all', async () => {
    await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('does-not-exist')
    })

    expect(latest?.settingsDialog).toBeNull()
    expect(latest?.settingsTarget).toBeNull()
  })

  // N7: the hint's job is to name *which* ancestor supplies the binding, so a snapshot taken at
  // open time can attribute the account to the wrong group after the ancestor changes.
  it('renames the inherited ancestor while the dialog is open', async () => {
    const rerender = await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('child')
    })
    expect(latest?.settingsTarget?.inherited?.configDir).toBe('/home/alice/.claude-client')

    await rerender([
      { ...PARENT, name: 'Client Work v2', claudeConfigDir: '/home/alice/.claude-v2' },
      UNBOUND_CHILD,
      REMOTE_CHILD
    ])

    expect(latest?.settingsTarget?.inherited).toEqual({
      configDir: '/home/alice/.claude-v2',
      groupId: 'parent',
      groupName: 'Client Work v2'
    })
  })

  it("follows the group's own binding while the dialog is open", async () => {
    const rerender = await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('child')
    })
    expect(latest?.settingsTarget?.configDir).toBeNull()

    await rerender([
      PARENT,
      { ...UNBOUND_CHILD, claudeConfigDir: '/home/alice/.claude-own' },
      REMOTE_CHILD
    ])

    expect(latest?.settingsTarget?.configDir).toBe('/home/alice/.claude-own')
  })

  it('drops the target when the open group leaves the catalog', async () => {
    const rerender = await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('child')
    })
    expect(latest?.settingsTarget).not.toBeNull()

    await rerender([PARENT, REMOTE_CHILD])

    expect(latest?.settingsTarget).toBeNull()
  })

  // R2: losing contact with a host is normal on SSH, so the dialog going away must be explained
  // rather than silent — and the open state has to go with it.
  it('closes the open dialog and says why when the group leaves the catalog', async () => {
    const rerender = await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('remote-child', 'runtime:env-1')
    })
    expect(latest?.settingsDialog).not.toBeNull()

    await rerender([PARENT, UNBOUND_CHILD])

    expect(latest?.settingsDialog).toBeNull()
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('does not re-open the dialog by itself when the host comes back', async () => {
    const rerender = await renderHookProbe()

    act(() => {
      latest?.handleOpenProjectGroupSettings('remote-child', 'runtime:env-1')
    })
    await rerender([PARENT, UNBOUND_CHILD])
    await rerender(DEFAULT_GROUPS)

    expect(latest?.settingsDialog).toBeNull()
    expect(latest?.settingsTarget).toBeNull()
  })
})
