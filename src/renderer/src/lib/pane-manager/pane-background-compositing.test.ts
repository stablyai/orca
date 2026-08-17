import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  disposePaneTerminalBackgroundObserver,
  observePaneTerminalBackground
} from './pane-background-compositing'

const observers: { callback: MutationCallback; disconnect: ReturnType<typeof vi.fn> }[] = []

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal(
    'MutationObserver',
    class {
      readonly disconnect = vi.fn()

      constructor(readonly callback: MutationCallback) {
        observers.push(this)
      }

      observe(): void {}
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminal padding background compositing', () => {
  it('tracks live xterm background changes and releases the observer', () => {
    const terminalElement = { style: { backgroundColor: 'rgba(0, 0, 0, 0.5)' } }
    const setProperty = vi.fn()
    const pane = {
      terminal: { element: terminalElement },
      xtermContainer: {
        style: { setProperty }
      }
    } as unknown as ManagedPaneInternal

    observePaneTerminalBackground(pane)
    expect(setProperty).toHaveBeenCalledWith(
      '--orca-terminal-live-background',
      'rgba(0, 0, 0, 0.5)'
    )

    terminalElement.style.backgroundColor = 'rgb(255, 0, 0)'
    observers[0]?.callback([], observers[0] as unknown as MutationObserver)
    expect(setProperty).toHaveBeenLastCalledWith(
      '--orca-terminal-live-background',
      'rgb(255, 0, 0)'
    )

    disposePaneTerminalBackgroundObserver(pane)
    expect(observers[0]?.disconnect).toHaveBeenCalled()
  })
})
