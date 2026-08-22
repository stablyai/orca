import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { ProjectGroupHeaderMenu } from './project-group-header-actions'

type MenuProps = React.PropsWithChildren<Record<string, unknown>> & { onSelect?: () => void }

// Why: Radix only mounts content when open; a pass-through mock exposes items and their props.
function passthrough(tag: string) {
  return ({ children, onSelect, ...props }: MenuProps) =>
    React.createElement(
      tag,
      {
        'data-testid': onSelect ? 'menu-item' : undefined,
        'data-disabled': props.disabled ? 'true' : undefined,
        'data-project-group-move-target': props['data-project-group-move-target'],
        style: props.style
      },
      children
    )
}

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: MenuProps) => React.createElement(React.Fragment, null, children),
  DropdownMenuTrigger: ({ children }: MenuProps) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: MenuProps) => React.createElement('div', null, children),
  DropdownMenuItem: passthrough('div'),
  DropdownMenuSeparator: () => React.createElement('hr'),
  DropdownMenuSub: ({ children }: MenuProps) => React.createElement(React.Fragment, null, children),
  DropdownMenuSubTrigger: ({ children }: MenuProps) =>
    React.createElement('div', { 'data-testid': 'submenu-trigger' }, children),
  DropdownMenuSubContent: ({ children }: MenuProps) => React.createElement('div', null, children)
}))

function group(id: string, parentGroupId: string | null, tabOrder = 0): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId: 'local'
  }
}

const perc = group('perc', null, 0)
const backend = group('backend', 'perc', 0)
const api = group('api', 'backend', 0)
const tools = group('tools', null, 1)
const groups = [perc, backend, api, tools]

function renderMenu(groupId: string, projectGroups: readonly ProjectGroup[] = groups): string {
  return renderToStaticMarkup(
    <ProjectGroupHeaderMenu
      groupId={groupId}
      label={groupId}
      projectGroups={projectGroups}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onCreateSubgroup={vi.fn()}
      onMoveToGroup={vi.fn()}
    />
  )
}

function moveTargets(markup: string): string[] {
  return [...markup.matchAll(/data-project-group-move-target="([^"]+)"/g)].map((match) => match[1]!)
}

describe('ProjectGroupHeaderMenu nesting entries', () => {
  it('offers a subgroup entry next to rename and delete', () => {
    const markup = renderMenu('perc')

    expect(markup).toContain('New subgroup…')
    expect(markup).toContain('Rename group')
    expect(markup).toContain('Delete group')
  })

  it('lists move destinations without the group itself or its descendants', () => {
    const markup = renderMenu('perc')

    expect(markup).toContain('Move to group')
    expect(markup).toContain('Top level')
    expect(moveTargets(markup)).toEqual(['tools'])
  })

  it('disables Top level for root groups and the current parent for nested ones', () => {
    const rootMarkup = renderMenu('perc')
    expect(rootMarkup).toMatch(/data-disabled="true"[^>]*>Top level/)

    const nestedMarkup = renderMenu('api')
    expect(nestedMarkup).not.toMatch(/data-disabled="true"[^>]*>Top level/)
    expect(moveTargets(nestedMarkup)).toEqual(['perc', 'backend', 'tools'])
    expect(nestedMarkup).toMatch(/data-disabled="true" data-project-group-move-target="backend"/)
  })

  it('indents nested destinations to mirror the sidebar tree', () => {
    const markup = renderMenu('tools')

    expect(markup).toMatch(/data-project-group-move-target="perc" style="padding-left:8px"/)
    expect(markup).toMatch(/data-project-group-move-target="backend" style="padding-left:18px"/)
    expect(markup).toMatch(/data-project-group-move-target="api" style="padding-left:28px"/)
  })

  it('hides the move submenu when a root group has nowhere to go', () => {
    const markup = renderMenu('perc', [perc])

    expect(markup).not.toContain('Move to group')
    expect(markup).toContain('New subgroup…')
  })
})
