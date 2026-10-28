// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('does not leave a delayed focus request behind after focusing an existing terminal', () => {
  const requestFrame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const root = document.createElement('div')
  root.dataset.terminalTabId = 'visible-tab'
  const pane = document.createElement('div')
  pane.dataset.leafId = 'leaf'
  const terminalInput = document.createElement('textarea')
  terminalInput.className = 'xterm-helper-textarea'
  pane.append(terminalInput)
  root.append(pane)
  document.body.append(root)

  focusTerminalTabSurface('visible-tab', 'leaf', { immediate: true, onlyWithinTab: true })
  expect(document.activeElement).toBe(terminalInput)
  const dialogInput = document.createElement('input')
  document.body.append(dialogInput)
  dialogInput.focus()
  expect(document.activeElement).toBe(dialogInput)
  expect(requestFrame).not.toHaveBeenCalled()
})
