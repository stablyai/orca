// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumePageFocusLossForTerminalIme } from './regular-terminal-focus-ownership'
import { useRegularTerminalInputFocus } from './use-regular-terminal-input-focus'

function mountTerminal(): { helper: HTMLTextAreaElement; blur: ReturnType<typeof vi.spyOn> } {
  const container = document.createElement('div')
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  container.appendChild(helper)
  document.body.appendChild(container)
  renderHook(() => useRegularTerminalInputFocus({ containerRef: { current: container } }))
  return { helper, blur: vi.spyOn(helper, 'blur') }
}

function arriveFrom(helper: HTMLElement, relatedTarget: EventTarget | null): void {
  helper.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget }))
}

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)')
  vi.stubGlobal('requestAnimationFrame', () => 0)
  Object.assign(window, { api: { ui: {} } })
  consumePageFocusLossForTerminalIme()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('useRegularTerminalInputFocus macOS input context rebuild', () => {
  it('rebuilds when focus returns from a browser page through the tab strip', () => {
    const { helper, blur } = mountTerminal()
    const tab = document.createElement('div')

    window.dispatchEvent(new Event('blur'))
    arriveFrom(helper, tab)

    expect(blur).toHaveBeenCalledOnce()
  })

  it('rebuilds when focus comes from a renderer text field', () => {
    const { helper, blur } = mountTerminal()
    const addressBar = document.createElement('input')

    arriveFrom(helper, addressBar)

    expect(blur).toHaveBeenCalledOnce()
  })
})
