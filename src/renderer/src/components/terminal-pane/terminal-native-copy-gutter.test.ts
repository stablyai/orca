// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const settings: { current: Partial<GlobalSettings> } = { current: {} }

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: settings.current }) }
}))

const { installTerminalNativeCopyGutterTrim } = await import('./terminal-native-copy-gutter')

const GUTTERED = ['  Retry limit is now 5.', '  Backoff starts at 2s.'].join('\n')

const UNGUTTERED = ['Retry limit is now 5.', 'Backoff starts at 2s.'].join('\n')

function makeTerminal(selection: string) {
  const element = document.createElement('div')
  document.body.appendChild(element)

  return {
    element,
    getSelection: () => selection,
    hasSelection: () => selection.length > 0
  }
}

function dispatchCopy(element: HTMLElement) {
  const written = new Map<string, string>()
  const event = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { setData: (type: string, data: string) => written.set(type, data) }
  })
  element.dispatchEvent(event)

  return { written, defaultPrevented: event.defaultPrevented }
}

describe('installTerminalNativeCopyGutterTrim', () => {
  beforeEach(() => {
    settings.current = {}
    document.body.innerHTML = ''
  })

  // Why: xterm's own `copy` listener writes raw screen cells, so a native copy
  // Orca does not bind (Ctrl+Insert on Windows/Linux) would carry the gutter.
  it('writes the un-guttered text for a native copy event', () => {
    const terminal = makeTerminal(GUTTERED)
    installTerminalNativeCopyGutterTrim(terminal)
    const { written, defaultPrevented } = dispatchCopy(terminal.element)
    expect(written.get('text/plain')).toBe(UNGUTTERED)
    expect(defaultPrevented).toBe(true)
  })

  it('honours the opt-out', () => {
    settings.current = { terminalCopyTrimsGutter: false }
    const terminal = makeTerminal(GUTTERED)
    installTerminalNativeCopyGutterTrim(terminal)
    expect(dispatchCopy(terminal.element).written.get('text/plain')).toBe(GUTTERED)
  })

  it('leaves an empty selection to the default handler', () => {
    const terminal = makeTerminal('')
    installTerminalNativeCopyGutterTrim(terminal)
    const { written, defaultPrevented } = dispatchCopy(terminal.element)
    expect(written.size).toBe(0)
    expect(defaultPrevented).toBe(false)
  })

  it('stops writing once disposed', () => {
    const terminal = makeTerminal(GUTTERED)
    installTerminalNativeCopyGutterTrim(terminal).dispose()
    expect(dispatchCopy(terminal.element).written.size).toBe(0)
  })

  it('is inert before xterm has opened an element', () => {
    expect(() =>
      installTerminalNativeCopyGutterTrim({
        element: undefined,
        getSelection: () => GUTTERED,
        hasSelection: () => true
      }).dispose()
    ).not.toThrow()
  })
})
