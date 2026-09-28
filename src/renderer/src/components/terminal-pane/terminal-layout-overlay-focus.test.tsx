// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { fitAndFocusPanes } from './pane-helpers'

function createLayoutFixture() {
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  document.body.append(textarea)
  textarea.focus()
  const terminal = { focus: vi.fn(() => textarea.focus()) }
  const manager = {
    fitAllPanes: vi.fn(),
    getActivePane: () => ({ terminal }),
    getPanes: () => [{ terminal }]
  } as unknown as PaneManager
  return { manager, terminal, textarea }
}

function mountOverlay(role: string) {
  const overlay = document.createElement('div')
  overlay.setAttribute('role', role)
  overlay.tabIndex = -1
  vi.spyOn(overlay, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 100, 100)
  ] as unknown as DOMRectList)
  document.body.append(overlay)
  return overlay
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('terminal layout preserves overlay focus', () => {
  it.each(['menu', 'dialog', 'alertdialog', 'listbox'])(
    'does not blur an open %s during a queued fit',
    (role) => {
      const { manager, terminal } = createLayoutFixture()
      const overlay = mountOverlay(role)
      overlay.focus()
      const blurred = vi.fn()
      overlay.addEventListener('blur', blurred)

      fitAndFocusPanes(manager)

      expect(manager.fitAllPanes).toHaveBeenCalledOnce()
      expect(terminal.focus).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(overlay)
      expect(blurred).not.toHaveBeenCalled()
    }
  )

  it('leaves a mounted menu time to acquire focus', () => {
    const { manager, terminal, textarea } = createLayoutFixture()
    textarea.blur()
    mountOverlay('menu')

    fitAndFocusPanes(manager)

    expect(terminal.focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(document.body)
  })

  it('allows focus after the menu closes', () => {
    const { manager, terminal, textarea } = createLayoutFixture()
    const overlay = mountOverlay('menu')
    overlay.focus()
    overlay.remove()

    fitAndFocusPanes(manager)

    expect(terminal.focus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(textarea)
  })

  it('hands focus back to a menu that is animating closed', () => {
    const { manager, terminal, textarea } = createLayoutFixture()
    mountOverlay('menu').setAttribute('data-state', 'closed')

    fitAndFocusPanes(manager)

    expect(terminal.focus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(textarea)
  })

  it('does not treat the workspace sidebar as a focus-owning overlay', () => {
    const { manager, terminal } = createLayoutFixture()
    const sidebar = mountOverlay('listbox')
    sidebar.setAttribute('data-worktree-sidebar', '')

    fitAndFocusPanes(manager)

    expect(terminal.focus).toHaveBeenCalledOnce()
  })
})
