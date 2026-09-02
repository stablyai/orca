// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { isSidebarPointerDragBlocked } from './worktree-sidebar-pointer-drag-dom'

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
})
