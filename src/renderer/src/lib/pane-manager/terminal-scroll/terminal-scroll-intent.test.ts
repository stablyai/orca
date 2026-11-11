import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalScrollIntentKind,
  markTerminalFollowOutput,
  markTerminalPinnedViewport
} from './terminal-scroll-intent'

import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'
import './terminal-scroll-intent-rebuild'

function createTerminal({
  viewportY,
  baseY,
  type = 'normal'
}: {
  viewportY: number
  baseY: number
  type?: 'normal' | 'alternate'
}) {
  const terminal = {
    buffer: {
      active: {
        type,
        viewportY,
        baseY
      }
    },
    scrollToBottom: vi.fn(() => {
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      terminal.buffer.active.viewportY = line
    })
  }
  return terminal
}

class TestElement extends EventTarget {}

describe('terminal scroll intent', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not let an old terminal disposal overwrite its keyed successor', () => {
    vi.stubGlobal('Element', TestElement)
    const firstTerminal = createTerminal({ viewportY: 76, baseY: 100 })
    const firstDisposable = attachTerminalScrollIntentTracking(
      firstTerminal,
      new TestElement() as unknown as HTMLElement,
      'leaf-dispose-successor'
    )
    markTerminalPinnedViewport(firstTerminal)

    const successor = createTerminal({ viewportY: 100, baseY: 100 })
    const successorDisposable = attachTerminalScrollIntentTracking(
      successor,
      new TestElement() as unknown as HTMLElement,
      'leaf-dispose-successor'
    )
    markTerminalFollowOutput(successor)
    firstTerminal.buffer.active.baseY = 150
    firstDisposable.dispose()

    expect(getTerminalScrollIntentKind(successor)).toBe('followOutput')
    successorDisposable.dispose()
  })
})
