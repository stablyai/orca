// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { sendTerminalInputAfterComposition } from './terminal-ime-deferred-newline'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

describe('sendTerminalInputAfterComposition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for every overlapping captured xterm transaction', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const terminal = { input: vi.fn() }
    const transport = {
      getPtyId: () => 'pty-1'
    } as unknown as PtyTransport
    const route = installTerminalImeCompositionRoute({
      terminalElement: el,
      terminal,
      capturedTransport: transport,
      getCurrentTransport: () => transport
    })
    const sessionEvent = (type: string, id: number) =>
      new CustomEvent(type, { detail: { id, data: `commit-${id}` } })

    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, 1))
    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, 2))
    sendTerminalInputAfterComposition(el, send)
    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, 1))
    vi.advanceTimersByTime(0)
    expect(send).not.toHaveBeenCalled()

    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, 2))
    vi.advanceTimersByTime(0)
    expect(send).toHaveBeenCalledTimes(1)

    route.dispose()
  })

  // Later compositions must not overtake Enter: 한 Enter 글 must not arrive as 한글 then newline.
  it('does not let a composition started after the defer hold the newline', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const terminal = { input: vi.fn() }
    const transport = { getPtyId: () => 'pty-1' } as unknown as PtyTransport
    const route = installTerminalImeCompositionRoute({
      terminalElement: el,
      terminal,
      capturedTransport: transport,
      getCurrentTransport: () => transport
    })
    const sessionEvent = (type: string, id: number, data: string) =>
      new CustomEvent(type, { cancelable: true, detail: { id, data } })

    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, 1, ''))
    const stopWaiting = sendTerminalInputAfterComposition(el, send, { fallbackMs: null })
    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, 2, ''))
    expect(send).not.toHaveBeenCalled()

    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, 1, '한'))
    vi.advanceTimersByTime(0)

    expect(send).toHaveBeenCalledTimes(1)
    expect(terminal.input.mock.calls).toEqual([['한']])

    stopWaiting()
    route.dispose()
  })
})
