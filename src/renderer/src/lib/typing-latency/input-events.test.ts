// @vitest-environment happy-dom
import { XTERM_COMPOSITION_SESSION_END_EVENT } from '@/components/terminal-pane/terminal-ime-composition-route'
import { afterEach, describe, expect, it } from 'vitest'
import { installTypingLatencyInputEvents, type TypingInputSignal } from './input-events'

function keydown(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', init))
}

function sessionEnd(data: string, dataPendingReconciliation = false): void {
  window.dispatchEvent(
    new CustomEvent(XTERM_COMPOSITION_SESSION_END_EVENT, {
      detail: { id: 1, data, dataPendingReconciliation }
    })
  )
}

describe('installTypingLatencyInputEvents', () => {
  let detach: (() => void) | null = null

  afterEach(() => {
    detach?.()
    detach = null
    document.body.replaceChildren()
  })

  it('classifies direct keys and ignores IME-owned preedit keydowns', () => {
    const signals: TypingInputSignal[] = []
    detach = installTypingLatencyInputEvents(window, (signal) => {
      signals.push(signal)
    })

    keydown({ key: 'Process', code: 'KeyG', isComposing: true })
    keydown({ key: 'a', code: 'KeyA', isComposing: true })
    keydown({ key: '@', code: 'Digit2', keyCode: 229 })
    keydown({ key: 'Shift', code: 'ShiftLeft' })
    keydown({ key: 'a', code: 'KeyA' })
    keydown({ key: 'Enter', code: 'Enter' })

    expect(signals.map(({ source, text }) => ({ source, text }))).toEqual([
      { source: 'direct', text: 'a' },
      { source: 'direct', text: 'Enter' }
    ])
  })

  it('uses reconciled xterm session data instead of raw compositionend data', () => {
    const signals: TypingInputSignal[] = []
    detach = installTypingLatencyInputEvents(window, (signal) => {
      signals.push(signal)
    })

    window.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }))
    sessionEnd('')
    sessionEnd('stale', true)
    sessionEnd('한')

    expect(signals.map(({ source, text }) => ({ source, text }))).toEqual([
      { source: 'ime', text: '한' }
    ])
  })

  it('detaches every listener', () => {
    const signals: TypingInputSignal[] = []
    detach = installTypingLatencyInputEvents(window, (signal) => {
      signals.push(signal)
    })
    detach()
    detach = null

    keydown({ key: 'a' })
    sessionEnd('한')

    expect(signals).toEqual([])
  })

  it('settles prevented and unprevented commits once after propagation', () => {
    const terminalElement = document.createElement('div')
    document.body.appendChild(terminalElement)
    const settlements: boolean[] = []
    detach = installTypingLatencyInputEvents(window, (signal) =>
      signal.source === 'ime'
        ? { settleAfterPropagation: (defaultPrevented) => settlements.push(defaultPrevented) }
        : undefined
    )

    const dispatchSessionEnd = (): void => {
      terminalElement.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_SESSION_END_EVENT, {
          bubbles: true,
          cancelable: true,
          detail: { id: 1, data: '한' }
        })
      )
    }
    dispatchSessionEnd()

    terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, (event) =>
      event.preventDefault()
    )
    dispatchSessionEnd()

    expect(settlements).toEqual([false, true])
  })
})
