// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { applyActivePaneStyles } from './pane-active-border'
import type { ManagedPaneInternal } from './pane-manager-types'

function buildSplit(): { root: HTMLElement; panes: ManagedPaneInternal[] } {
  const root = document.createElement('div')
  const containers = [1, 2].map(() => root.appendChild(document.createElement('div')))

  return {
    root,
    panes: containers.map((container, index) => ({
      id: index + 1,
      container
    })) as unknown as ManagedPaneInternal[]
  }
}

/** happy-dom has no layout, so geometry tests stub the rects. */
function stubRect(el: HTMLElement, rect: Partial<DOMRect>): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...rect }) as DOMRect
}

const borderIn = (root: HTMLElement): HTMLElement | null =>
  root.querySelector(':scope > .pane-active-border')

const ON = { activePaneBorderEnabled: true, activePaneBorderColor: 'red', dividerThicknessPx: 3 }

describe('applyActivePaneStyles', () => {
  it('draws the configured stroke and reaches over divider edges only', () => {
    const { root, panes } = buildSplit()
    stubRect(root, { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 })
    // Pane 2 fills the right half: only its left edge sits on the divider.
    stubRect(panes[1].container, {
      left: 54,
      top: 0,
      right: 100,
      bottom: 100,
      width: 46,
      height: 100
    })

    applyActivePaneStyles(root, panes, 2, ON)

    const border = borderIn(root)
    expect(border?.style.borderColor).toBe('red')
    expect(border?.style.borderWidth).toBe('3px')
    // reach = hit padding 3 + thickness 3
    expect(border?.style.left).toBe('48px')
    expect(border?.style.width).toBe('52px')
    expect(border?.style.top).toBe('0px')
    expect(border?.style.height).toBe('100px')
  })

  it('keeps a single border element when the active pane changes', () => {
    const { root, panes } = buildSplit()

    applyActivePaneStyles(root, panes, 1, ON)
    applyActivePaneStyles(root, panes, 2, ON)

    expect(root.querySelectorAll('.pane-active-border').length).toBe(1)
  })

  it('removes the border when the setting is off or no pane is active', () => {
    const { root, panes } = buildSplit()

    applyActivePaneStyles(root, panes, 2, ON)
    expect(borderIn(root)).not.toBeNull()

    applyActivePaneStyles(root, panes, 2, { ...ON, activePaneBorderEnabled: false })
    expect(borderIn(root)).toBeNull()

    applyActivePaneStyles(root, panes, 2, ON)
    applyActivePaneStyles(root, panes, null, ON)
    expect(borderIn(root)).toBeNull()
  })
})
