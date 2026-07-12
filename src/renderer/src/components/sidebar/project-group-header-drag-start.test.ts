// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { createProjectGroupHeaderDragSession } from './project-group-header-drag-start'
import type { ProjectGroup } from '../../../../shared/types'

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

describe('createProjectGroupHeaderDragSession', () => {
  it('arms a drag session from plain header text when the row is the drag handle', () => {
    const header = document.createElement('div')
    header.setAttribute('data-project-group-header-drag-handle', '')
    header.setPointerCapture = vi.fn()
    const label = document.createElement('span')
    header.append(label)
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer, header)

    const projectGroupById = new Map<string, ProjectGroup>([
      ['group-a', group('group-a')],
      ['group-b', group('group-b')]
    ])
    const sidebarProjectGroupHeaderIdsByBucket = new Map([['root', ['group-a', 'group-b']]])

    const session = createProjectGroupHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: label,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      groupId: 'group-a',
      projectGroupById,
      sidebarProjectGroupHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session?.groupId).toBe('group-a')
    expect(header.setPointerCapture).not.toHaveBeenCalled()
  })

  it('does not arm from nested Project Group header actions', () => {
    const header = document.createElement('div')
    header.setAttribute('data-project-group-header-drag-handle', '')
    const action = document.createElement('button')
    action.type = 'button'
    header.append(action)
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer, header)

    const projectGroupById = new Map<string, ProjectGroup>([
      ['group-a', group('group-a')],
      ['group-b', group('group-b')]
    ])
    const sidebarProjectGroupHeaderIdsByBucket = new Map([['root', ['group-a', 'group-b']]])

    const session = createProjectGroupHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: action,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      groupId: 'group-a',
      projectGroupById,
      sidebarProjectGroupHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session).toBeNull()
  })
})
