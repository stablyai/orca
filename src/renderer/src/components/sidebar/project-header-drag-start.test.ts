// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { createProjectHeaderDragSession } from './project-header-drag-start'
import type { Repo } from '../../../../shared/repo-types'

function createRepo(id: string, projectGroupId: string | null = null): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    projectGroupId,
    projectGroupOrder: 0
  }
}

describe('createProjectHeaderDragSession', () => {
  it('does not capture the pointer when arming a drag session', () => {
    const handleEl = document.createElement('div')
    handleEl.setAttribute('data-repo-header-drag-handle', '')
    handleEl.setPointerCapture = vi.fn()
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer, handleEl)

    const sidebarRepoHeaderIdsByBucket = new Map([['ungrouped', ['repo-a', 'repo-b']]])

    const session = createProjectHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: handleEl,
        currentTarget: handleEl
      } as unknown as React.PointerEvent<HTMLElement>,
      repo: createRepo('repo-a'),
      sidebarRepoHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session).not.toBeNull()
    expect(handleEl.setPointerCapture).not.toHaveBeenCalled()
  })

  it('arms a drag session from plain project header text when the row is the drag handle', () => {
    const header = document.createElement('div')
    header.setAttribute('data-repo-header-drag-handle', '')
    const label = document.createElement('span')
    header.append(label)
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer, header)

    const sidebarRepoHeaderIdsByBucket = new Map([['ungrouped', ['repo-a', 'repo-b']]])

    const session = createProjectHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: label,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      repo: createRepo('repo-a'),
      sidebarRepoHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session?.repo.id).toBe('repo-a')
  })

  it('arms a drag session when pressing the project icon svg (SVGElement target)', () => {
    const header = document.createElement('div')
    header.setAttribute('data-repo-header-drag-handle', '')
    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    header.append(iconSvg)
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer, header)

    const sidebarRepoHeaderIdsByBucket = new Map([['ungrouped', ['repo-a', 'repo-b']]])

    const session = createProjectHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: iconSvg,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      repo: createRepo('repo-a'),
      sidebarRepoHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session?.repo.id).toBe('repo-a')
  })

  it('does not arm a drag session when pressing an svg icon inside an action button', () => {
    const header = document.createElement('div')
    header.setAttribute('data-repo-header-drag-handle', '')
    const actionButton = document.createElement('button')
    actionButton.setAttribute('data-repo-header-action', '')
    const actionIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    actionButton.append(actionIcon)
    header.append(actionButton)
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer, header)

    const sidebarRepoHeaderIdsByBucket = new Map([['ungrouped', ['repo-a', 'repo-b']]])

    const session = createProjectHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: actionIcon,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      repo: createRepo('repo-a'),
      sidebarRepoHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session).toBeNull()
  })

  it('does not arm a drag session when pressing the actions overlay even if the row is the drag handle', () => {
    const header = document.createElement('div')
    header.setAttribute('data-repo-header-drag-handle', '')
    const dragSurface = document.createElement('div')
    const label = document.createElement('span')
    dragSurface.append(label)
    const actions = document.createElement('div')
    actions.setAttribute('data-repo-header-actions', '')
    header.append(dragSurface, actions)
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer, header)

    const sidebarRepoHeaderIdsByBucket = new Map([['ungrouped', ['repo-a', 'repo-b']]])

    const sessionFromActions = createProjectHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: actions,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      repo: createRepo('repo-a'),
      sidebarRepoHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })
    const sessionFromLabel = createProjectHeaderDragSession({
      event: {
        button: 0,
        pointerId: 2,
        clientX: 10,
        clientY: 20,
        target: label,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      repo: createRepo('repo-a'),
      sidebarRepoHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })
    const sessionFromRowPadding = createProjectHeaderDragSession({
      event: {
        button: 0,
        pointerId: 3,
        clientX: 10,
        clientY: 20,
        target: header,
        currentTarget: header
      } as unknown as React.PointerEvent<HTMLElement>,
      repo: createRepo('repo-a'),
      sidebarRepoHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(sessionFromActions).toBeNull()
    expect(sessionFromLabel?.repo.id).toBe('repo-a')
    // Why: target === currentTarget is treated as the empty row (not an action).
    expect(sessionFromRowPadding?.repo.id).toBe('repo-a')
  })
})

it.each([
  ['group:remote', 'group:local'],
  [JSON.stringify(['ungrouped', false]), JSON.stringify(['ungrouped', true])]
])(
  'uses the clicked row bucket %s rather than a same-id twin in %s',
  (clickedBucket, twinBucket) => {
    const handle = document.createElement('div')
    handle.setAttribute('data-repo-header-drag-handle', '')
    handle.setAttribute('data-repo-header-bucket', clickedBucket)
    const container = document.createElement('div')
    const session = createProjectHeaderDragSession({
      event: {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 20,
        target: handle,
        currentTarget: handle
      },
      repo: {
        ...createRepo('same', clickedBucket.startsWith('group:') ? 'remote' : null),
        executionHostId: 'runtime:remote'
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        [twinBucket, ['same', 'local-sibling']],
        [clickedBucket, ['same', 'remote-sibling']]
      ]),
      getScrollContainer: () => container
    })
    expect(session?.bucketKey).toBe(clickedBucket)
    expect(session?.sidebarRepoHeaderIds).toEqual(['same', 'remote-sibling'])
  }
)
