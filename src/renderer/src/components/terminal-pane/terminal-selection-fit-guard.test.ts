import { describe, expect, it, vi } from 'vitest'
import { installTerminalSelectionFitGuard } from './terminal-selection-fit-guard'

function setup() {
  const terminalElement = new EventTarget()
  const ownerDocument = new EventTarget()
  const ownerWindow = new EventTarget()
  Object.assign(terminalElement, { ownerDocument })
  Object.assign(ownerDocument, { defaultView: ownerWindow })
  const terminal = { element: terminalElement }
  const onSelectionEnd = vi.fn()
  const guard = installTerminalSelectionFitGuard(terminal, onSelectionEnd)
  return { terminalElement, ownerDocument, ownerWindow, guard, onSelectionEnd }
}

function mouseEvent(button: number): Event {
  const event = new Event('mousedown')
  Object.defineProperty(event, 'button', { value: button })
  return event
}

describe('terminal selection fit guard', () => {
  it('stays active from primary mousedown through mouseup and requests convergence', () => {
    const { terminalElement, ownerDocument, guard, onSelectionEnd } = setup()

    terminalElement.dispatchEvent(mouseEvent(0))
    expect(guard.isActive()).toBe(true)
    ownerDocument.dispatchEvent(new Event('mouseup'))
    expect(guard.isActive()).toBe(false)
    expect(onSelectionEnd).toHaveBeenCalledOnce()
    guard.dispose()
  })

  it('ignores non-primary buttons and clears an interrupted drag', () => {
    const { terminalElement, ownerDocument, ownerWindow, guard, onSelectionEnd } = setup()

    terminalElement.dispatchEvent(mouseEvent(2))
    expect(guard.isActive()).toBe(false)
    terminalElement.dispatchEvent(mouseEvent(0))
    ownerWindow.dispatchEvent(new Event('blur'))
    ownerDocument.dispatchEvent(new Event('mouseup'))
    expect(guard.isActive()).toBe(false)
    expect(onSelectionEnd).not.toHaveBeenCalled()
    guard.dispose()
  })
})
