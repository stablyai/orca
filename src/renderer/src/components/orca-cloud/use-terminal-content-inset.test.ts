// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  TERMINAL_CONTENT_INSET_PX,
  measureTerminalContentInset
} from './use-terminal-content-inset'

type Box = { left: number; top: number; width: number; height: number }

function placed(element: HTMLElement, box: Box): HTMLElement {
  element.getBoundingClientRect = () => new DOMRect(box.left, box.top, box.width, box.height)
  return element
}

function layout(withHeaderIcons: boolean) {
  // surface > cover > overlay root (the anchor); the terminal is a sibling of the cover.
  const surface = placed(document.createElement('div'), {
    left: 0,
    top: 0,
    width: 1000,
    height: 800
  })
  const terminal = placed(document.createElement('div'), {
    left: 0,
    top: 40,
    width: 1000,
    height: 760
  })
  terminal.className = 'xterm'
  surface.append(terminal)
  if (withHeaderIcons) {
    // Split and close are drawn over the terminal's top-right corner.
    const icons = placed(document.createElement('div'), {
      left: 900,
      top: 36,
      width: 90,
      height: 24
    })
    icons.className = 'pane-title-actions'
    surface.append(icons)
  }
  const cover = document.createElement('div')
  const anchor = placed(document.createElement('div'), {
    left: 0,
    top: 0,
    width: 1000,
    height: 800
  })
  cover.append(anchor)
  surface.append(cover)
  document.body.append(surface)
  return anchor
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('where the waking pill sits over the terminal', () => {
  it('8 px inside the terminal content, below the tab strip', () => {
    expect(measureTerminalContentInset(layout(false))).toEqual({
      top: 40 + TERMINAL_CONTENT_INSET_PX,
      right: TERMINAL_CONTENT_INSET_PX
    })
  })

  it('below the pane header icons drawn over the terminal’s top edge, so they stay clickable', () => {
    expect(measureTerminalContentInset(layout(true))?.top).toBe(60 + TERMINAL_CONTENT_INSET_PX)
  })
})
