/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest'

import { isFloatingTerminalDragTarget } from './floating-terminal-titlebar-drag-target'

afterEach(() => {
  document.body.replaceChildren()
})

describe('floating panel titlebar drag target', () => {
  it('does not move the panel when a tab SVG icon receives the press', () => {
    const tab = document.createElement('div')
    tab.dataset.tabId = 'terminal-tab'
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    tab.appendChild(icon)
    document.body.appendChild(tab)

    expect(isFloatingTerminalDragTarget(icon)).toBe(false)
  })

  it('still moves the panel from bare titlebar chrome', () => {
    const titlebar = document.createElement('div')
    document.body.appendChild(titlebar)
    expect(isFloatingTerminalDragTarget(titlebar)).toBe(true)
  })
})
