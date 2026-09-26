// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'

vi.mock('@/components/terminal-pane/terminal-ime-input-context-refresh', () => ({
  refreshTerminalImeInputContext: vi.fn()
}))

describe('deferred split terminal focus', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it.each([null, 'left'])(
    'preserves a pane reveal unless an explicit leaf (%s) was requested',
    (requestedLeaf) => {
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
      })
      vi.stubGlobal('cancelAnimationFrame', vi.fn())
      const tab = document.createElement('div')
      tab.dataset.terminalTabId = 'floating-tab'
      const inputs = ['left', 'right'].map((leafId) => {
        const pane = document.createElement('div')
        pane.dataset.leafId = leafId
        const input = document.createElement('textarea')
        input.className = 'xterm-helper-textarea'
        pane.append(input)
        tab.append(pane)
        return input
      })
      document.body.append(tab)

      focusTerminalTabSurface('floating-tab', requestedLeaf)
      frames.shift()?.(0)
      // The activity row focuses the right pane before the panel's deferred focus completes.
      inputs[1].focus()
      frames.shift()?.(0)

      expect(document.activeElement).toBe(inputs[requestedLeaf ? 0 : 1])
    }
  )
})
