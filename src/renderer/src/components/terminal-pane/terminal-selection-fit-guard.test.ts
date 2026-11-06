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

  it('resolves drag-end waiters on mouseup, blur, and dispose', async () => {
    const { terminalElement, ownerDocument, ownerWindow, guard } = setup()
    const settled = vi.fn()

    await expect(guard.whenInactive()).resolves.toBeUndefined()

    terminalElement.dispatchEvent(mouseEvent(0))
    void guard.whenInactive().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    ownerDocument.dispatchEvent(new Event('mouseup'))
    await Promise.resolve()
    expect(settled).toHaveBeenCalledOnce()

    terminalElement.dispatchEvent(mouseEvent(0))
    const afterBlur = guard.whenInactive()
    ownerWindow.dispatchEvent(new Event('blur'))
    await expect(afterBlur).resolves.toBeUndefined()

    terminalElement.dispatchEvent(mouseEvent(0))
    const afterDispose = guard.whenInactive()
    guard.dispose()
    await expect(afterDispose).resolves.toBeUndefined()
  })

  it('keeps a primary drag active across a secondary press and release', () => {
    const { terminalElement, ownerDocument, guard, onSelectionEnd } = setup()
    const withButtons = (type: string, button: number, buttons: number): Event => {
      const event = new Event(type)
      Object.defineProperty(event, 'button', { value: button })
      Object.defineProperty(event, 'buttons', { value: buttons })
      return event
    }

    terminalElement.dispatchEvent(withButtons('mousedown', 0, 1))
    terminalElement.dispatchEvent(withButtons('mousedown', 2, 3))
    expect(guard.isActive()).toBe(true)
    ownerDocument.dispatchEvent(withButtons('mouseup', 2, 1))
    expect(guard.isActive()).toBe(true)
    expect(onSelectionEnd).not.toHaveBeenCalled()
    ownerDocument.dispatchEvent(withButtons('mouseup', 0, 0))
    expect(guard.isActive()).toBe(false)
    expect(onSelectionEnd).toHaveBeenCalledOnce()
    guard.dispose()
  })
})
