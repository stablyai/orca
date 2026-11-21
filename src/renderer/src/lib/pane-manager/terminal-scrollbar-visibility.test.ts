import type { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { applyTerminalScrollbarSettings } from './terminal-scrollbar-visibility'

const ATTRIBUTE = 'data-terminal-scrollbar-always-visible'

function createFakeTerminal(): {
  terminal: Terminal
  buffer: { type: 'normal' | 'alternate'; baseY: number }
  fire: () => void
  fireWriteParsed: () => void
  widthWrites: () => number
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial fake exposing only what the code under test reads
  const buffer = { type: 'normal' as 'normal' | 'alternate', baseY: 0 }
  const listeners: (() => void)[] = []
  const writeParsedListeners: (() => void)[] = []
  let widthWrites = 0
  let scrollbar: { width?: number } | undefined = { width: 7 }
  const subscribe = (listener: () => void): { dispose: () => void } => {
    listeners.push(listener)
    return { dispose: () => {} }
  }
  const terminal = {
    buffer: { active: buffer, onBufferChange: subscribe },
    onScroll: subscribe,
    onResize: subscribe,
    onWriteParsed: (listener: () => void): { dispose: () => void } => {
      writeParsedListeners.push(listener)
      return { dispose: () => {} }
    },
    options: {
      get scrollbar() {
        return scrollbar
      },
      set scrollbar(value) {
        widthWrites += 1
        scrollbar = value
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial fake exposing only what the code under test reads
  } as unknown as Terminal
  return {
    terminal,
    buffer,
    fire: () => listeners.forEach((listener) => listener()),
    fireWriteParsed: () => writeParsedListeners.forEach((listener) => listener()),
    widthWrites: () => widthWrites
  }
}

function createFakeContainer(): { container: HTMLElement; has: () => boolean } {
  const attributes = new Set<string>()
  const container = {
    toggleAttribute: (name: string, force: boolean) => {
      if (force) {
        attributes.add(name)
      } else {
        attributes.delete(name)
      }
      return force
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial fake exposing only what the code under test reads
  } as unknown as HTMLElement
  return { container, has: () => attributes.has(ATTRIBUTE) }
}

describe('applyTerminalScrollbarSettings', () => {
  it('only forces the scrollbar on while the normal buffer has scrollback', () => {
    const { terminal, buffer, fire } = createFakeTerminal()
    const { container, has } = createFakeContainer()
    applyTerminalScrollbarSettings(terminal, container, { terminalScrollbarAlwaysVisible: true })
    expect(has()).toBe(false)

    buffer.baseY = 40
    fire()
    expect(has()).toBe(true)

    buffer.type = 'alternate'
    fire()
    expect(has()).toBe(false)

    buffer.type = 'normal'
    buffer.baseY = 0
    fire()
    expect(has()).toBe(false)
  })

  it('turns the bar back off when a write erases the scrollback without scrolling or resizing', () => {
    const { terminal, buffer, fire, fireWriteParsed } = createFakeTerminal()
    const { container, has } = createFakeContainer()
    applyTerminalScrollbarSettings(terminal, container, { terminalScrollbarAlwaysVisible: true })
    buffer.baseY = 40
    fire()
    expect(has()).toBe(true)

    // `clear` / `Clear-Host` send ED 3: baseY drops to 0 and no scroll, resize or buffer event fires.
    buffer.baseY = 0
    fireWriteParsed()
    expect(has()).toBe(false)
  })

  it('stays off when the setting is turned off even with scrollback', () => {
    const { terminal, buffer } = createFakeTerminal()
    const { container, has } = createFakeContainer()
    buffer.baseY = 40
    applyTerminalScrollbarSettings(terminal, container, { terminalScrollbarAlwaysVisible: true })
    expect(has()).toBe(true)
    applyTerminalScrollbarSettings(terminal, container, { terminalScrollbarAlwaysVisible: false })
    expect(has()).toBe(false)
  })

  it('writes the width option only when it changes', () => {
    const { terminal, widthWrites } = createFakeTerminal()
    const { container } = createFakeContainer()
    applyTerminalScrollbarSettings(terminal, container, { terminalScrollbarWidth: 7 })
    expect(widthWrites()).toBe(0)
    applyTerminalScrollbarSettings(terminal, container, { terminalScrollbarWidth: 12 })
    applyTerminalScrollbarSettings(terminal, container, { terminalScrollbarWidth: 12 })
    expect(widthWrites()).toBe(1)
    expect(terminal.options.scrollbar?.width).toBe(12)
  })
})
