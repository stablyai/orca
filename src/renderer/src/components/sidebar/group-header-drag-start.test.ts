// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { createGroupHeaderDragSession } from './group-header-drag-start'
import type { ProjectGroup } from '../../../../shared/types'

function createGroup(id: string, parentGroupId: string | null = null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeHandleEl(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-group-header-drag-handle', '')
  document.body.appendChild(el)
  return el
}

function makeScrollContainer(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

function makeEvent(
  target: HTMLElement,
  currentTarget: HTMLElement,
  button = 0
): React.PointerEvent<HTMLElement> {
  return {
    button,
    pointerId: 1,
    clientX: 10,
    clientY: 20,
    target,
    currentTarget
  } as unknown as React.PointerEvent<HTMLElement>
}

describe('createGroupHeaderDragSession', () => {
  it('returns null when the pointer event is not on a drag-handle element', () => {
    // target is a plain div without data-group-header-drag-handle
    const nonHandle = document.createElement('div')
    const currentTarget = document.createElement('div')
    currentTarget.appendChild(nonHandle)
    document.body.appendChild(currentTarget)

    const groupId = 'group-a'
    const group = createGroup(groupId)
    const groupsById = new Map<string, ProjectGroup>([[groupId, group]])
    const siblingGroupIdsByParent = new Map<string | null, readonly string[]>([
      [null, ['group-a', 'group-b']]
    ])
    const scrollContainer = makeScrollContainer()

    const session = createGroupHeaderDragSession({
      event: makeEvent(nonHandle, currentTarget),
      groupId,
      groupsById,
      siblingGroupIdsByParent,
      getScrollContainer: () => scrollContainer
    })

    expect(session).toBeNull()
  })

  it('returns null when the event button is not 0 (non-left click)', () => {
    const handleEl = makeHandleEl()
    const scrollContainer = makeScrollContainer()

    const groupId = 'group-a'
    const group = createGroup(groupId)
    const groupsById = new Map<string, ProjectGroup>([[groupId, group]])
    const siblingGroupIdsByParent = new Map<string | null, readonly string[]>([
      [null, ['group-a', 'group-b']]
    ])

    const session = createGroupHeaderDragSession({
      event: makeEvent(handleEl, handleEl, 2),
      groupId,
      groupsById,
      siblingGroupIdsByParent,
      getScrollContainer: () => scrollContainer
    })

    expect(session).toBeNull()
  })

  it('returns null when the group has ≤1 sibling in its parent bucket (lone-group guard)', () => {
    const handleEl = makeHandleEl()
    const scrollContainer = makeScrollContainer()

    const groupId = 'group-a'
    const group = createGroup(groupId)
    const groupsById = new Map<string, ProjectGroup>([[groupId, group]])
    // Only one group in the parent bucket — should be blocked
    const siblingGroupIdsByParent = new Map<string | null, readonly string[]>([[null, ['group-a']]])

    const session = createGroupHeaderDragSession({
      event: makeEvent(handleEl, handleEl),
      groupId,
      groupsById,
      siblingGroupIdsByParent,
      getScrollContainer: () => scrollContainer
    })

    expect(session).toBeNull()
  })

  it('returns a valid session when all guards pass', () => {
    const handleEl = makeHandleEl()
    const scrollContainer = makeScrollContainer()

    const groupId = 'group-a'
    const group = createGroup(groupId)
    const groupsById = new Map<string, ProjectGroup>([[groupId, group]])
    const siblings: readonly string[] = ['group-a', 'group-b']
    const siblingGroupIdsByParent = new Map<string | null, readonly string[]>([[null, siblings]])

    const session = createGroupHeaderDragSession({
      event: makeEvent(handleEl, handleEl),
      groupId,
      groupsById,
      siblingGroupIdsByParent,
      getScrollContainer: () => scrollContainer
    })

    expect(session).not.toBeNull()
    expect(session?.groupId).toBe(groupId)
    expect(session?.parentGroupId).toBeNull()
    expect(session?.siblingGroupIds).toEqual(siblings)
    expect(session?.pointerId).toBe(1)
    expect(session?.handleEl).toBe(handleEl)
    expect(session?.promoted).toBe(false)
  })
})
