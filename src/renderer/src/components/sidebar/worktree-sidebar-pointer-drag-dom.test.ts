// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  createSidebarDragPreview,
  isSidebarPointerDragBlocked
} from './worktree-sidebar-pointer-drag-dom'

describe('worktree sidebar pointer drag DOM guards', () => {
  it('allows plain row targets to start pointer drags', () => {
    const row = document.createElement('div')
    const card = document.createElement('div')
    row.appendChild(card)

    expect(isSidebarPointerDragBlocked(card, row)).toBe(false)
  })

  it('blocks portaled hover card targets outside the row', () => {
    const row = document.createElement('div')
    const hoverCardContent = document.createElement('div')
    document.body.append(row, hoverCardContent)

    expect(isSidebarPointerDragBlocked(hoverCardContent, row)).toBe(true)

    hoverCardContent.remove()
    row.remove()
  })

  it('blocks interactive targets inside the row', () => {
    const row = document.createElement('div')
    const button = document.createElement('button')
    row.appendChild(button)

    expect(isSidebarPointerDragBlocked(button, row)).toBe(true)
  })

  it('blocks icon targets inside interactive row controls', () => {
    const row = document.createElement('div')
    const button = document.createElement('button')
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    button.appendChild(icon)
    row.appendChild(button)

    expect(isSidebarPointerDragBlocked(icon, row)).toBe(true)
  })

  it('builds a compact preview without agent trees, lineage children, or duplicate row ids', () => {
    const row = document.createElement('div')
    row.setAttribute('data-worktree-id', 'parent')
    row.setAttribute('data-worktree-drag-id', 'parent')
    row.setAttribute('data-worktree-lineage-drop-id', 'parent')
    row.getBoundingClientRect = () => ({ left: 10, top: 20, width: 220, height: 500 }) as DOMRect
    const title = document.createElement('div')
    title.textContent = 'Parent workspace'
    const agents = document.createElement('div')
    agents.setAttribute('data-worktree-card-agent-list', '')
    agents.textContent = '12 agents'
    const children = document.createElement('div')
    children.setAttribute('data-worktree-legacy-lineage-children', '')
    children.setAttribute('data-worktree-id', 'child')
    children.textContent = 'Child workspace'
    row.append(title, agents, children)

    const { preview } = createSidebarDragPreview({
      sourceRow: row,
      pointerX: 80,
      pointerY: 40,
      draggedCount: 1
    })

    expect(preview.textContent).toContain('Parent workspace')
    expect(preview.textContent).not.toContain('12 agents')
    expect(preview.textContent).not.toContain('Child workspace')
    expect(preview.querySelector('[data-worktree-id]')).toBeNull()
    expect(preview.querySelector('[data-worktree-lineage-drop-id]')).toBeNull()
    preview.remove()
  })
})
