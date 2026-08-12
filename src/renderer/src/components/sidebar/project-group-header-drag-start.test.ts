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

  it('arms from the group icon svg (SVGElement target)', () => {
    const header = document.createElement('div')
    header.setAttribute('data-project-group-header-drag-handle', '')
    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    header.append(iconSvg)
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
        target: iconSvg,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      groupId: 'group-a',
      projectGroupById,
      sidebarProjectGroupHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session?.groupId).toBe('group-a')
  })

  it('does not arm when pressing an svg icon inside an action button', () => {
    // Why: row stays the handle for hit-testing; action targets must be filtered.
    const header = document.createElement('div')
    header.setAttribute('data-project-group-header-drag-handle', '')
    const actionButton = document.createElement('button')
    actionButton.setAttribute('data-repo-header-action', '')
    const actionIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    actionButton.append(actionIcon)
    header.append(actionButton)
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
        target: actionIcon,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      groupId: 'group-a',
      projectGroupById,
      sidebarProjectGroupHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session).toBeNull()
  })

  it('does not arm from the actions overlay even if the row is the drag handle', () => {
    // Why: row keeps the handle attr for indent/padding; overlay gaps must still be excluded.
    const header = document.createElement('div')
    header.setAttribute('data-project-group-header-drag-handle', '')
    const dragSurface = document.createElement('div')
    const label = document.createElement('span')
    dragSurface.append(label)
    const actions = document.createElement('div')
    actions.setAttribute('data-repo-header-actions', '')
    header.append(dragSurface, actions)
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer, header)

    const projectGroupById = new Map<string, ProjectGroup>([
      ['group-a', group('group-a')],
      ['group-b', group('group-b')]
    ])
    const sidebarProjectGroupHeaderIdsByBucket = new Map([['root', ['group-a', 'group-b']]])

    const sessionFromActions = createProjectGroupHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: actions,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      groupId: 'group-a',
      projectGroupById,
      sidebarProjectGroupHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })
    const sessionFromLabel = createProjectGroupHeaderDragSession({
      event: {
        button: 0,
        pointerId: 2,
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
    const sessionFromRowPadding = createProjectGroupHeaderDragSession({
      event: {
        button: 0,
        pointerId: 3,
        clientX: 10,
        clientY: 20,
        target: header,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      groupId: 'group-a',
      projectGroupById,
      sidebarProjectGroupHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(sessionFromActions).toBeNull()
    expect(sessionFromLabel?.groupId).toBe('group-a')
    expect(sessionFromRowPadding?.groupId).toBe('group-a')
  })
})
