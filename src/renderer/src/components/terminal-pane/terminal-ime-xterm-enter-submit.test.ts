// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  shouldSuppressTerminalImeKeyboardEvent,
  type XtermImeKeyboardOptions
} from './xterm-bypass-policy'
import { installTerminalImeCompositionTracker } from './terminal-ime-composition-tracker'

const MAC_COMPOSING_OPTIONS: XtermImeKeyboardOptions = {
  compositionActive: true,
  candidateKeyGuardActive: true,
  pendingCandidateKeyReleaseActive: false,
  isMac: true,
  isLinux: false
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(options?: { useProductionTracker?: boolean }): {
  compositionActive: () => boolean
  dispose: () => void
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  const tracker = options?.useProductionTracker
    ? installTerminalImeCompositionTracker(terminal.element, { isMac: true })
    : null
  terminal.attachCustomKeyEventHandler(
    (event) =>
      !shouldSuppressTerminalImeKeyboardEvent(
        event,
        tracker
          ? {
              ...MAC_COMPOSING_OPTIONS,
              compositionActive: tracker.isActive(),
              candidateKeyGuardActive: tracker.isCandidateKeyGuardActive()
            }
          : MAC_COMPOSING_OPTIONS
      )
  )
  return {
    compositionActive: () => tracker?.isActive() ?? false,
    dispose: () => {
      tracker?.dispose()
      terminal.dispose()
    },
    emitted,
    terminal,
    textarea
  }
}

function startComposition(textarea: HTMLTextAreaElement, text: string): void {
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }))
  textarea.value = text
}

function pressEnter(
  textarea: HTMLTextAreaElement,
  options: { isComposing: boolean; keyCode: number; shiftKey?: boolean }
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    shiftKey: options.shiftKey ?? false
  })
  Object.defineProperty(event, 'isComposing', { value: options.isComposing })
  Object.defineProperty(event, 'keyCode', { value: options.keyCode })
  textarea.dispatchEvent(event)
  return event
}

describe('macOS IME Enter submission through xterm', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('emits committed Hangul before the plain Enter submission', async () => {
    const { dispose, emitted, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    pressEnter(textarea, { isComposing: true, keyCode: 13 })
    await nextEventLoop()

    expect(emitted).toEqual(['한', '\r'])
    dispose()
  })

  it('lets a plain Enter submit when only the production Orca tracker remains active', () => {
    const { compositionActive, dispose, emitted, terminal, textarea } = openTerminal({
      useProductionTracker: true
    })
    // Why: target Orca's tracker element directly so xterm's own CompositionHelper
    // stays inactive, matching a stale tracker after a missed compositionend.
    terminal.element?.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(compositionActive()).toBe(true)

    pressEnter(textarea, { isComposing: false, keyCode: 13 })

    expect(emitted).toEqual(['\r'])
    expect(compositionActive()).toBe(false)
    dispose()
  })

  it('commits on Process/229 Enter and waits for the following plain Enter to submit', async () => {
    const { dispose, emitted, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    const processEnter = pressEnter(textarea, { isComposing: true, keyCode: 229 })
    await nextEventLoop()

    expect(processEnter.defaultPrevented).toBe(false)
    expect(emitted).toEqual([])

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    await nextEventLoop()
    expect(emitted).toEqual(['한'])

    pressEnter(textarea, { isComposing: false, keyCode: 13 })
    expect(emitted).toEqual(['한', '\r'])
    dispose()
  })
})
