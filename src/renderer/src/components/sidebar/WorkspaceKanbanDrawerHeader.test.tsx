import React, { isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import SidebarFilter from './SidebarFilter'
import WorkspaceKanbanDrawerHeader from './WorkspaceKanbanDrawerHeader'
import WorkspaceKanbanSearchField from './WorkspaceKanbanSearchField'
import WorkspaceKanbanSettingsMenu from './WorkspaceKanbanSettingsMenu'

type InspectableProps = {
  children?: React.ReactNode
  className?: string
  'aria-label'?: string
  onClick?: () => void
}

const statuses: WorkspaceStatusDefinition[] = [{ id: 'todo', label: 'Todo' }]

function findNode(
  node: React.ReactNode,
  predicate: (element: React.ReactElement<InspectableProps>) => boolean
): React.ReactElement<InspectableProps> | null {
  if (!isValidElement<InspectableProps>(node)) {
    return null
  }
  if (predicate(node)) {
    return node
  }
  let match: React.ReactElement<InspectableProps> | null = null
  React.Children.forEach(node.props.children, (child) => {
    if (match) {
      return
    }
    match = findNode(child, predicate)
  })
  return match
}

function findElement(
  node: React.ReactNode,
  predicate: (props: InspectableProps) => boolean
): React.ReactElement<InspectableProps> | null {
  return findNode(node, (element) => predicate(element.props))
}

function findByType(
  node: React.ReactNode,
  type: React.ElementType
): React.ReactElement<InspectableProps> | null {
  return findNode(node, (element) => element.type === type)
}

function renderHeader(
  onClose: () => void,
  overrides: Partial<Parameters<typeof WorkspaceKanbanDrawerHeader>[0]> = {}
): React.ReactElement {
  return WorkspaceKanbanDrawerHeader({
    selectedCount: 0,
    query: '',
    isFiltering: false,
    isTooLarge: false,
    matchCount: 0,
    totalCount: 0,
    onQueryChange: vi.fn(),
    onClearQuery: vi.fn(),
    workspaceStatuses: statuses,
    syncTaskStatusFromWorkspaceBoard: false,
    onSyncTaskStatusFromWorkspaceBoardChange: vi.fn(),
    onRenameStatus: vi.fn(),
    onChangeStatusColor: vi.fn(),
    onChangeStatusIcon: vi.fn(),
    onMoveStatus: vi.fn(),
    onRemoveStatus: vi.fn(),
    onAddStatus: vi.fn(),
    onFilterMenuOpenChange: vi.fn(),
    onClose,
    ...overrides
  })
}

describe('WorkspaceKanbanDrawerHeader', () => {
  it('routes the close button through the explicit drawer close callback', () => {
    const onClose = vi.fn()
    const closeButton = findElement(
      renderHeader(onClose),
      (props) => props['aria-label'] === 'Close'
    )

    expect(closeButton?.props.onClick).toBe(onClose)

    closeButton?.props.onClick?.()

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders the search field as a sibling of the sheet title, not inside it', () => {
    const header = renderHeader(vi.fn(), {
      query: 'orca',
      isFiltering: true,
      matchCount: 2,
      totalCount: 15
    })

    const title = findByType(header, SheetTitle)
    expect(title).not.toBeNull()
    expect(findByType(title, WorkspaceKanbanSearchField)).toBeNull()

    const field = findByType(header, WorkspaceKanbanSearchField)
    expect(field?.props).toMatchObject({
      query: 'orca',
      isFiltering: true,
      matchCount: 2,
      totalCount: 15
    })
  })

  it('keeps the filter, settings, and close cluster reachable alongside the field', () => {
    const header = renderHeader(vi.fn(), {
      query: 'orca',
      isFiltering: true,
      matchCount: 2,
      totalCount: 15
    })

    expect(findByType(header, SidebarFilter)).not.toBeNull()
    expect(findByType(header, WorkspaceKanbanSettingsMenu)).not.toBeNull()
    expect(findElement(header, (props) => props['aria-label'] === 'Close')).not.toBeNull()
  })

  it('keeps the selected-count badge and the field clear of the control cluster', () => {
    const header = renderHeader(vi.fn(), { selectedCount: 3, query: 'orca' })

    // The title (with its badge) never shrinks the field into the absolute cluster,
    // which the header reserves space for with pr-32.
    expect(findByType(header, SheetTitle)?.props.className).toContain('shrink-0')
    expect(findByType(header, SheetHeader)?.props.className).toContain('pr-32')
    expect(
      findElement(header, (props) => Boolean(props.className?.includes('rounded-full')))
    ).not.toBeNull()
    expect(findByType(header, WorkspaceKanbanSearchField)).not.toBeNull()
  })
})
