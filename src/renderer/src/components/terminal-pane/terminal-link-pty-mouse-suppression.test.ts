// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'

function makeTerminal(): Terminal {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return { element, options: { mouseEventsRequireAlt: false } } as unknown as Terminal
}

function linkMouseDown(element: HTMLElement): void {
  element.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: true, ctrlKey: true })
  )
}

function settle(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => queueMicrotask(() => resolve())))
}

describe('link-click mouse suppression restore', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it.each([
    { baseline: false, label: 'gate off' },
    { baseline: true, label: 'gate on' }
  ])('restores the live setting after the gesture — $label', async ({ baseline }) => {
    const terminal = makeTerminal()
    terminal.options.mouseEventsRequireAlt = baseline
    const disposable = installTerminalLinkPtyMouseSuppression(
      terminal,
      () => true,
      () => baseline
    )

    linkMouseDown(terminal.element!)
    expect(terminal.options.mouseEventsRequireAlt).toBe(true)

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await settle()

    expect(terminal.options.mouseEventsRequireAlt).toBe(baseline)
    disposable.dispose()
  })

  // Why: applyTerminalAppearance can rewrite the option mid-gesture; a snapshot
  // restore would leave the pane ungated while the setting says gated.
  it('restores the value the setting holds at mouseup, not at mousedown', async () => {
    const terminal = makeTerminal()
    let gateEnabled = false
    const disposable = installTerminalLinkPtyMouseSuppression(
      terminal,
      () => true,
      () => gateEnabled
    )

    linkMouseDown(terminal.element!)
    gateEnabled = true
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await settle()

    expect(terminal.options.mouseEventsRequireAlt).toBe(true)
    disposable.dispose()
  })
})
