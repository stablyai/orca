import React, { isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import WorkspaceKanbanDrawerHeader from './WorkspaceKanbanDrawerHeader'

type InspectableProps = {
  children?: React.ReactNode
  'aria-label'?: string
  onClick?: () => void
}

const statuses: WorkspaceStatusDefinition[] = [{ id: 'todo', label: 'Todo' }]

function findElement(
  node: React.ReactNode,
  predicate: (props: InspectableProps) => boolean
): React.ReactElement<InspectableProps> | null {
  if (!isValidElement<InspectableProps>(node)) {
    return null
  }
  if (predicate(node.props)) {
    return node
  }
  let match: React.ReactElement<InspectableProps> | null = null
  React.Children.forEach(node.props.children, (child) => {
    if (match) {
      return
    }
    match = findElement(child, predicate)
  })
  return match
}

function renderHeader(onClose: () => void): React.ReactElement {
  return WorkspaceKanbanDrawerHeader({
    selectedCount: 0,
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
    onClose
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
})
