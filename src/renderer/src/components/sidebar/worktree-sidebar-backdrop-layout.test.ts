// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { readWorktreeSidebarCards } from './worktree-sidebar-backdrop-layout'

function placed<T extends HTMLElement>(element: T, rect: DOMRect): T {
  element.getBoundingClientRect = () => rect
  return element
}

function row(worktreeId: string, top: number, status: string): HTMLElement {
  const option = document.createElement('div')
  option.setAttribute('role', 'option')
  option.dataset.worktreeId = worktreeId
  const surface = placed(document.createElement('div'), new DOMRect(8, top, 260, 50))
  surface.setAttribute('data-worktree-card-surface', 'true')
  const indicator = document.createElement('span')
  indicator.dataset.worktreeStatus = status
  surface.append(indicator)
  option.append(surface)
  return option
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('readWorktreeSidebarCards', () => {
  it('reports each card with its own status and never the workspace id', () => {
    const root = placed(document.createElement('div'), new DOMRect(0, 0, 280, 600))
    const parent = row('repo::/Users/me/project', 100, 'inactive')
    const child = row('repo::/Users/me/project-child', 160, 'working')
    parent.querySelector('[data-worktree-card-surface]')!.append(child)
    parent.querySelector('[data-worktree-status]')!.remove()
    root.append(parent)
    document.body.append(root)
    const keys = new Map<string, number>()
    const keyOf = (id: string): number => keys.get(id) ?? keys.set(id, keys.size).get(id)!

    const withStatus = readWorktreeSidebarCards(root, keyOf, true)
    const withoutStatus = readWorktreeSidebarCards(root, keyOf, false)

    expect(withStatus.cards).toEqual([
      { key: 0, x: 8, y: 100, width: 260, height: 50, hovered: false, active: false },
      {
        key: 1,
        x: 8,
        y: 160,
        width: 260,
        height: 50,
        hovered: false,
        active: false,
        status: 'working'
      }
    ])
    expect(withoutStatus.cards.some((card) => 'status' in card)).toBe(false)
    expect(JSON.stringify(withStatus)).not.toContain('/Users/me')
  })
})
