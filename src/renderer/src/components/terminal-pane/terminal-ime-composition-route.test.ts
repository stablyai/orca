// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport'
import {
  hasPendingTerminalImeComposition,
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

function createTransport(ptyId: string | null): PtyTransport {
  return {
    getPtyId: vi.fn(() => ptyId)
  } as unknown as PtyTransport
}

function sessionEvent(
  type: string,
  id: number,
  data?: string,
  dataPendingReconciliation = false
): CustomEvent {
  return new CustomEvent(type, {
    bubbles: true,
    cancelable: true,
    detail: { id, data, dataPendingReconciliation }
  })
}

function createHarness(ptyId = 'pty-original') {
  const element = document.createElement('div')
  const original = createTransport(ptyId)
  const state: {
    currentTransport: PtyTransport | undefined
  } = {
    currentTransport: original
  }
  const input = vi.fn()
  const route = installTerminalImeCompositionRoute({
    terminalElement: element,
    terminal: { input },
    capturedTransport: original,
    getCurrentTransport: () => state.currentTransport
  })
  const start = (id: number) =>
    element.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, id))
  const end = (id: number, data: string) =>
    element.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, id, data))
  return { element, original, state, input, route, start, end }
}

describe('installTerminalImeCompositionRoute', () => {
  it('does not install on an uninitialized terminal element', () => {
    const transport = createTransport('pty-original')

    const route = installTerminalImeCompositionRoute({
      terminalElement: {} as HTMLElement,
      terminal: { input: vi.fn() },
      capturedTransport: transport,
      getCurrentTransport: () => transport
    })

    expect(() => route.dispose()).not.toThrow()
  })

  it.each(['visible blur', 'terminal tab switch', 'split pane switch'])(
    'delivers one Hangul commit to the captured route after %s',
    () => {
      const harness = createHarness()
      harness.start(1)

      expect(harness.end(1, '한')).toBe(false)
      expect(harness.input).toHaveBeenCalledExactlyOnceWith('한')
    }
  )

  it('never routes a switched composition to an unrelated transport', () => {
    const harness = createHarness()
    harness.start(1)
    harness.state.currentTransport = createTransport('pty-unrelated')

    harness.end(1, '한')

    expect(harness.input).not.toHaveBeenCalled()
  })

  it('finalizes empty cancellation without leaking into the next session', () => {
    const harness = createHarness()
    harness.start(1)
    harness.end(1, '')
    harness.start(2)
    harness.end(1, '한')
    harness.end(2, '글')

    expect(harness.input).toHaveBeenCalledExactlyOnceWith('글')
  })

  it('ignores duplicate and late composition completion', () => {
    const harness = createHarness()
    harness.start(1)
    harness.end(1, '한')
    harness.end(1, '한')

    expect(harness.input).toHaveBeenCalledExactlyOnceWith('한')
  })

  it('settles a session without forwarding bytes still pending xterm reconciliation', () => {
    const harness = createHarness()
    harness.start(1)

    harness.element.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, 1, '앙', true))

    expect(harness.input).not.toHaveBeenCalled()
    expect(hasPendingTerminalImeComposition(harness.element)).toBe(false)
  })

  it('keeps every captured session until its delayed completion', () => {
    const harness = createHarness()
    harness.start(1)
    harness.start(2)
    harness.start(3)
    expect(hasPendingTerminalImeComposition(harness.element)).toBe(true)
    harness.end(1, '안')
    harness.end(2, '녕')
    expect(hasPendingTerminalImeComposition(harness.element)).toBe(true)
    harness.end(3, '하')

    expect(harness.input.mock.calls).toEqual([['안'], ['녕'], ['하']])
    expect(hasPendingTerminalImeComposition(harness.element)).toBe(false)
  })

  it('drops a commit after same-pane PTY replacement', () => {
    const harness = createHarness()
    harness.start(1)
    vi.mocked(harness.original.getPtyId).mockReturnValue('pty-replacement')

    harness.end(1, '한')

    expect(harness.input).not.toHaveBeenCalled()
  })

  it('drops a commit after SSH reconnect replaces the transport', () => {
    const harness = createHarness('remote:env:pty-original')
    harness.start(1)
    harness.state.currentTransport = createTransport('remote:env:pty-replacement')

    harness.end(1, '한')

    expect(harness.input).not.toHaveBeenCalled()
  })

  // A route that never saw the start cannot deliver the commit, so cancelling the event would
  // suppress xterm's own triggerDataEvent with nothing standing in for it.
  it('leaves an uncaptured session to xterm when installed mid-composition', () => {
    const harness = createHarness()

    expect(harness.end(1, '한')).toBe(true)
    expect(harness.input).not.toHaveBeenCalled()
  })

  it('does not swallow a commit when the connection re-installs the route mid-composition', () => {
    const element = document.createElement('div')
    const transport = createTransport('pty-original')
    const input = vi.fn()
    const install = () =>
      installTerminalImeCompositionRoute({
        terminalElement: element,
        terminal: { input },
        capturedTransport: transport,
        getCurrentTransport: () => transport
      })
    const firstRoute = install()

    element.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, 1))
    // Reconnect/effect re-run swaps the route while the preedit is still open.
    firstRoute.dispose()
    const secondRoute = install()

    expect(element.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, 1, '한'))).toBe(
      true
    )
    expect(input).not.toHaveBeenCalled()

    secondRoute.dispose()
  })

  it('still suppresses xterm insertion for a captured session it deliberately drops', () => {
    const harness = createHarness()
    harness.start(1)
    harness.state.currentTransport = createTransport('pty-replacement')

    // Owned, so xterm must stand down — dropping the commit is this route's decision.
    expect(harness.end(1, '한')).toBe(false)
    expect(harness.input).not.toHaveBeenCalled()
  })

  it('keeps a shared session pending until every overlapping route releases it', () => {
    const element = document.createElement('div')
    const firstTransport = createTransport('pty-first')
    const secondTransport = createTransport('pty-second')
    const firstRoute = installTerminalImeCompositionRoute({
      terminalElement: element,
      terminal: { input: vi.fn() },
      capturedTransport: firstTransport,
      getCurrentTransport: () => firstTransport
    })
    const secondRoute = installTerminalImeCompositionRoute({
      terminalElement: element,
      terminal: { input: vi.fn() },
      capturedTransport: secondTransport,
      getCurrentTransport: () => secondTransport
    })

    element.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, 1))
    firstRoute.dispose()
    expect(hasPendingTerminalImeComposition(element)).toBe(true)

    secondRoute.dispose()
    expect(hasPendingTerminalImeComposition(element)).toBe(false)
  })

  it.each(['terminal close', 'tab unmount'])(
    'releases the captured session and listeners on %s',
    () => {
      const harness = createHarness()
      harness.start(1)
      harness.route.dispose()

      expect(harness.end(1, '한')).toBe(true)
      expect(harness.input).not.toHaveBeenCalled()
      expect(hasPendingTerminalImeComposition(harness.element)).toBe(false)
    }
  )
})
