// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  ProjectGroupHeaderMenu,
  type ProjectGroupHeaderActions
} from './project-group-header-actions'

type MenuItemProps = {
  children?: React.ReactNode
  disabled?: boolean
  onSelect?: () => void
  'data-project-group-move-target'?: string
}

// Why: Radix menus only mount content while open; render every layer so items can be asserted.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuSubTrigger: ({ children }: { children?: React.ReactNode }) =>
      React_.createElement('div', { 'data-sub-trigger': '' }, children),
    DropdownMenuSeparator: () => React_.createElement('hr'),
    DropdownMenuItem: (props: MenuItemProps) =>
      React_.createElement(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: props.disabled,
          'data-project-group-move-target': props['data-project-group-move-target'],
          onClick: () => props.onSelect?.()
        },
        props.children
      )
  }
})

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function chain(prefix: string, length: number, overrides: Partial<ProjectGroup> = {}) {
  return Array.from({ length }, (_, index) =>
    group(`${prefix}${index + 1}`, {
      ...overrides,
      parentGroupId: index === 0 ? null : `${prefix}${index}`
    })
  )
}

function createActions(): ProjectGroupHeaderActions {
  return { onRename: vi.fn(), onCreateSubgroup: vi.fn(), onMove: vi.fn(), onDelete: vi.fn() }
}

const roots: Root[] = []

function renderMenu(
  projectGroup: ProjectGroup,
  projectGroups: readonly ProjectGroup[],
  actions = createActions()
): ProjectGroupHeaderActions {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      <ProjectGroupHeaderMenu
        projectGroup={projectGroup}
        label={projectGroup.name}
        projectGroups={projectGroups}
        actions={actions}
      />
    )
  })
  return actions
}

function menuItem(label: string): HTMLButtonElement {
  const item = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  ).find((entry) => entry.textContent === label)
  if (!item) {
    throw new Error(`Menu item not found: ${label}`)
  }
  return item
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('ProjectGroupHeaderMenu', () => {
  it('orders the actions and disables New subgroup on a third-level group', () => {
    const levels = chain('level', 3)
    renderMenu(levels[2], levels)

    expect(
      Array.from(document.body.querySelectorAll('[role="menuitem"]')).map(
        (item) => item.textContent
      )
    ).toEqual(['Rename group', 'New subgroup', 'Top level', 'level1', 'level2', 'Delete group'])
    expect(menuItem('New subgroup').disabled).toBe(true)
    expect(menuItem('level2').disabled).toBe(true)
  })

  it("reads the level from the group's host, not from same-id groups on another host", () => {
    const local = chain('level', 2)
    const runtime = [
      ...chain('remote', 2, { executionHostId: 'runtime:env-1' }),
      group('level2', { parentGroupId: 'remote2', executionHostId: 'runtime:env-1' })
    ]
    renderMenu(local[1], [...local, ...runtime])

    expect(menuItem('New subgroup').disabled).toBe(false)
  })

  it("routes subgroup creation and moves to the group's owner host", () => {
    const parent = group('parent', { name: 'Parent', executionHostId: 'runtime:env-1' })
    const sibling = group('sibling', { name: 'Sibling', executionHostId: 'runtime:env-1' })
    const child = group('child', {
      name: 'Child',
      parentGroupId: 'parent',
      executionHostId: 'runtime:env-1'
    })
    const actions = renderMenu(child, [parent, sibling, child])

    act(() => menuItem('New subgroup').click())
    act(() => menuItem('Top level').click())
    act(() => menuItem('Sibling').click())

    expect(menuItem('Parent').disabled).toBe(true)
    expect(actions.onCreateSubgroup).toHaveBeenCalledWith('child', 'Child', 'runtime:env-1')
    expect(actions.onMove).toHaveBeenNthCalledWith(1, 'child', null, 'runtime:env-1')
    expect(actions.onMove).toHaveBeenNthCalledWith(2, 'child', 'sibling', 'runtime:env-1')
  })

  it('omits Move to group when the group has nowhere to go', () => {
    const only = group('only')
    renderMenu(only, [only, group('remote', { executionHostId: 'runtime:env-1' })])

    expect(document.body.textContent).not.toContain('Move to group')
    expect(document.body.textContent).not.toContain('Top level')
  })
})
