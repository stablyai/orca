// @vitest-environment happy-dom
// Replays a recorded Windows/WSL 2-Set Korean capture and asserts the preedit stayed visible for
// every composition update the IME actually emitted — 37 of them across 11 balanced sessions.
//
// It does NOT cover the resume-without-compositionstart ordering, and an earlier version of this
// file wrongly claimed it did. The capture logs each event twice (a dispatch record and a batched
// next-frame re-log); replaying both fabricates updates that appear to land after a session ended.
// Filtered to dispatch records the capture holds zero resumes. The fixture is now filtered, so this
// asserts real emissions only. The resume ordering is pinned synthetically in
// terminal-ime-xterm-resumed-preedit-visibility.test.ts, which says so.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import trace from './__fixtures__/windows-wsl-hangul-resumed-preedit-trace.json'

type RecordedEvent = {
  type: string
  inputType?: string
  data?: string
  key?: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  value?: string
  selectionStart?: number
  selectionEnd?: number
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function buildEvent(recorded: RecordedEvent): Event {
  if (recorded.type === 'keydown' || recorded.type === 'keyup') {
    const keyboard = new KeyboardEvent(recorded.type, {
      key: recorded.key,
      code: recorded.code,
      isComposing: recorded.isComposing,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keyboard, 'keyCode', { value: recorded.keyCode })
    return keyboard
  }
  if (recorded.type === 'input' || recorded.type === 'beforeinput') {
    const input = new InputEvent(recorded.type, {
      isComposing: recorded.isComposing,
      bubbles: true
    })
    // happy-dom drops these from InputEventInit; Chromium supplies them.
    Object.defineProperty(input, 'inputType', { value: recorded.inputType ?? '' })
    Object.defineProperty(input, 'data', { value: recorded.data ?? null })
    Object.defineProperty(input, 'composed', { value: true })
    return input
  }
  const composition = new CompositionEvent(recorded.type, { bubbles: true })
  Object.defineProperty(composition, 'data', { value: recorded.data ?? '' })
  return composition
}

describe('Windows/WSL Korean — recorded composition updates keep the preedit visible', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('keeps the preedit visible for every recorded update', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const terminal = new Terminal()
    terminal.open(container)
    const textarea = terminal.textarea
    if (!textarea) {
      throw new Error('xterm helper textarea was not created')
    }

    const events = trace.dom as RecordedEvent[]
    let compositionOpen = false
    const resumed: { data: string; shown: boolean }[] = []
    const shown: { data: string; visible: boolean }[] = []

    for (const recorded of events) {
      if (recorded.type === 'keydown' || recorded.type === 'keyup') {
        await nextEventLoop()
      }
      if (recorded.value !== undefined) {
        textarea.value = recorded.value
      }
      if (recorded.selectionStart !== undefined && recorded.selectionEnd !== undefined) {
        textarea.setSelectionRange(recorded.selectionStart, recorded.selectionEnd)
      }
      textarea.dispatchEvent(buildEvent(recorded))

      if (recorded.type === 'compositionstart') {
        compositionOpen = true
      } else if (recorded.type === 'compositionend') {
        compositionOpen = false
      } else if (recorded.type === 'compositionupdate' && recorded.data) {
        const view = terminal.element?.querySelector('.composition-view')
        const active = view?.classList.contains('active') === true
        shown.push({ data: recorded.data, visible: active })
        if (!compositionOpen) {
          resumed.push({ data: recorded.data, shown: active })
        }
      }
    }
    terminal.dispose()

    // Guards against a fixture that silently stops covering anything.
    expect(shown).toHaveLength(37)
    expect(shown.filter((sample) => !sample.visible)).toEqual([])
    // The real capture never resumes a composition without a start; if it ever appears to, the
    // fixture has picked up the batched re-log again.
    expect(resumed).toEqual([])
  })
})
