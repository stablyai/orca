// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { createProjectHeaderDragSession } from './project-header-drag-start'
import type { Repo } from '../../../../shared/types'

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

    const repoById = new Map<string, Repo>([['repo-a', createRepo('repo-a')]])
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
      repoId: 'repo-a',
      repoById,
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

    const repoById = new Map<string, Repo>([['repo-a', createRepo('repo-a')]])
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
      repoId: 'repo-a',
      repoById,
      sidebarRepoHeaderIdsByBucket,
      getScrollContainer: () => scrollContainer
    })

    expect(session?.repoId).toBe('repo-a')
  })
})
