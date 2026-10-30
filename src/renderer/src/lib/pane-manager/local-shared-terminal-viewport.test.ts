// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagedPane } from './pane-manager-types'
import { hydrateOverrides, setFitOverride } from './mobile-fit-overrides'
import {
  revealLocalSharedTerminalCursor,
  syncLocalSharedTerminalViewport
} from './local-shared-terminal-viewport'

afterEach(() => {
  hydrateOverrides([])
  document.body.innerHTML = ''
})

function createPane() {
  const container = document.createElement('div')
  container.dataset.ptyId = 'shared-pty'
  const viewport = document.createElement('div')
  viewport.style.overflow = 'hidden'
  const element = document.createElement('div')
  element.style.width = '100%'
  element.style.height = '100%'
  container.appendChild(viewport)
  viewport.appendChild(element)
  document.body.appendChild(container)
  Object.defineProperties(viewport, {
    clientWidth: { get: () => 500 },
    clientHeight: { get: () => 300 }
  })
  const renders = new Set<() => void>()
  const terminal = {
    element,
    cols: 160,
    rows: 40,
    options: { fontSize: 14, scrollback: 5000, scrollbar: { width: 7 } },
    dimensions: {
      device: {
        cell: { width: 9 * window.devicePixelRatio, height: 18 * window.devicePixelRatio }
      },
      css: { cell: { width: 9, height: 18 } }
    },
    buffer: { active: { cursorX: 100, cursorY: 30 } },
    onRender: (callback: () => void) => {
      renders.add(callback)
      return { dispose: () => renders.delete(callback) }
    },
    resize: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every public terminal and DOM member read by viewport presentation.
  const pane = { container, terminal } as unknown as ManagedPane
  return {
    pane,
    terminal,
    viewport,
    element,
    render: () => renders.forEach((callback) => callback())
  }
}

it('scrolls the frozen grid locally at native font size and restores ordinary layout on release', () => {
  const { pane, terminal, viewport, element, render } = createPane()
  setFitOverride('shared-pty', 'remote-desktop-fit', 160, 40, true)
  syncLocalSharedTerminalViewport(pane)

  expect(element.style.width).toBe('1447px')
  expect(element.style.height).toBe('720px')
  expect(viewport.style.overflow).toBe('auto')
  expect(viewport.dataset.localSharedGrid).toBe('true')
  expect(element.style.transform).toBe('')
  expect(terminal.options.fontSize).toBe(14)
  viewport.scrollLeft = 200
  viewport.scrollTop = 100
  render()
  expect(viewport.scrollLeft).toBe(200)
  expect(viewport.scrollTop).toBe(100)
  expect(terminal.resize).not.toHaveBeenCalled()

  revealLocalSharedTerminalCursor(pane)
  expect(viewport.scrollLeft).toBe(409)
  expect(viewport.scrollTop).toBe(258)
  terminal.buffer.active.cursorX = 150
  terminal.buffer.active.cursorY = 35
  render()
  expect(viewport.scrollLeft).toBe(859)
  expect(viewport.scrollTop).toBe(348)

  setFitOverride('shared-pty', 'desktop-fit', 160, 40)
  syncLocalSharedTerminalViewport(pane)
  expect(element.style.width).toBe('100%')
  expect(element.style.height).toBe('100%')
  expect(viewport.style.overflow).toBe('hidden')
  expect(viewport.dataset.localSharedGrid).toBeUndefined()
  expect(viewport.scrollLeft).toBe(0)
  expect(viewport.scrollTop).toBe(0)
})

it('does not change mobile or ordinary remote-desktop presentation', () => {
  const { pane, element, viewport } = createPane()
  for (const mode of ['mobile-fit', 'remote-desktop-fit'] as const) {
    setFitOverride('shared-pty', mode, 40, 20)
    syncLocalSharedTerminalViewport(pane)
    expect(element.style.width).toBe('100%')
    expect(viewport.style.overflow).toBe('hidden')
  }
})
