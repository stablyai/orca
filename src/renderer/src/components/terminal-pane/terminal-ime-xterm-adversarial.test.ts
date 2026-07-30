// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { Terminal as EsmTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armTerminalImeDeletionReleaseGuard,
  consumeTerminalImeDeletionRelease,
  createTerminalImeDeletionReleaseGuard
} from './terminal-ime-deletion-release-guard'
import { shouldSuppressTerminalImeKeyboardEvent } from './xterm-bypass-policy'

const requireFromHere = createRequire(import.meta.url)
const { Terminal: CjsTerminal } = requireFromHere('@xterm/xterm') as {
  Terminal: typeof EsmTerminal
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(TerminalType: typeof EsmTerminal): {
  emitted: string[]
  terminal: EsmTerminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new TerminalType()
  terminal.open(container)
  if (!terminal.textarea) {
    throw new Error('xterm textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea: terminal.textarea }
}

function composition(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data?: string
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  if (data !== undefined) {
    Object.defineProperty(event, 'data', { value: data })
  }
  textarea.dispatchEvent(event)
}

function start(textarea: HTMLTextAreaElement, text: string): void {
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  composition(textarea, 'compositionstart')
  composition(textarea, 'compositionupdate', text)
  textarea.value += text
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
}

function compositionState(terminal: EsmTerminal): {
  endTimer?: unknown
  positionTimer?: unknown
  timers: Set<unknown>
  viewTimer?: unknown
} {
  const helper = (
    terminal as unknown as {
      _core: {
        _compositionHelper: {
          _compositionEndTimer?: unknown
          _compositionPositionTimer?: unknown
          _compositionTimers: Set<unknown>
          _compositionViewTimer?: unknown
        }
      }
    }
  )._core._compositionHelper
  return {
    endTimer: helper._compositionEndTimer,
    positionTimer: helper._compositionPositionTimer,
    timers: helper._compositionTimers,
    viewTimer: helper._compositionViewTimer
  }
}

describe.each([
  ['ESM', EsmTerminal],
  ['CJS', CjsTerminal]
])('installed xterm adversarial composition ownership (%s)', (_format, TerminalType) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('rejects a stale end between an immediate restart and its first update', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    start(textarea, 'A')
    await nextEventLoop()
    composition(textarea, 'compositionend', 'A')

    textarea.setSelectionRange(1, 1)
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionend', 'A')
    await nextEventLoop()
    composition(textarea, 'compositionupdate', 'B')
    textarea.value = 'AB'
    textarea.setSelectionRange(2, 2)
    composition(textarea, 'compositionend', 'B')
    await nextEventLoop()

    expect(emitted.join('')).toBe('AB')
    terminal.dispose()
  })

  it('accepts a repeated no-update commit after textarea progress', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    start(textarea, '가')
    composition(textarea, 'compositionend', '가')
    composition(textarea, 'compositionstart')
    textarea.value = '가가'
    textarea.setSelectionRange(2, 2)
    composition(textarea, 'compositionend', '가')
    await nextEventLoop()

    expect(emitted.join('')).toBe('가가')
    terminal.dispose()
  })

  it('accepts repeated no-update data when native progress follows the end event', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    const lifecycle: string[] = []
    textarea.addEventListener('xterm-composition-transaction-accepted', () =>
      lifecycle.push('accepted')
    )
    textarea.addEventListener('xterm-composition-transaction-settled', () =>
      lifecycle.push('settled')
    )
    start(textarea, '가')
    composition(textarea, 'compositionend', '가')
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionend', '가')
    textarea.value = '가가'
    textarea.setSelectionRange(2, 2)
    await nextEventLoop()

    expect(emitted.join('')).toBe('가가')
    expect(lifecycle).toEqual(['accepted', 'settled', 'accepted', 'settled'])
    terminal.dispose()
  })

  it('rejects a data-less stale end before restarted progress', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    start(textarea, 'A')
    composition(textarea, 'compositionend', 'A')
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionend')
    await nextEventLoop()
    composition(textarea, 'compositionupdate', 'B')
    textarea.value = 'AB'
    textarea.setSelectionRange(2, 2)
    composition(textarea, 'compositionend', 'B')
    await nextEventLoop()

    expect(emitted.join('')).toBe('AB')
    terminal.dispose()
  })

  it('rejects a stale end after update but before textarea progress', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    start(textarea, 'A')
    composition(textarea, 'compositionend', 'A')
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', 'B')
    composition(textarea, 'compositionend', 'A')
    await nextEventLoop()
    textarea.value = 'AB'
    textarea.setSelectionRange(2, 2)
    composition(textarea, 'compositionend', 'B')
    await nextEventLoop()

    expect(emitted.join('')).toBe('AB')
    terminal.dispose()
  })

  it('accepts native Microsoft Pinyin deletion of a one-letter preedit', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    start(textarea, 'm')
    await nextEventLoop()

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'Backspace',
        keyCode: 229,
        bubbles: true,
        cancelable: true
      })
    )
    composition(textarea, 'compositionupdate', '')
    textarea.value = ''
    textarea.setSelectionRange(0, 0)
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: null,
        inputType: 'deleteContentBackward',
        isComposing: false
      })
    )
    composition(textarea, 'compositionend', '')
    await nextEventLoop()

    const compositionView = terminal.element?.querySelector<HTMLElement>('.composition-view')
    expect(compositionView?.textContent?.replaceAll('\u200e', '')).toBe('')
    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('does not leak the paired Backspace release under Kitty event reporting', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    const deletionReleaseGuard = createTerminalImeDeletionReleaseGuard()
    let compositionActive = false
    textarea.addEventListener('compositionstart', () => {
      compositionActive = true
    })
    textarea.addEventListener('compositionend', () => {
      compositionActive = false
    })
    terminal.attachCustomKeyEventHandler((keyboardEvent) => {
      const now = Date.now()
      const pendingCompositionDeletionReleaseActive = consumeTerminalImeDeletionRelease(
        deletionReleaseGuard,
        keyboardEvent,
        now
      )
      armTerminalImeDeletionReleaseGuard(
        deletionReleaseGuard,
        keyboardEvent,
        compositionActive,
        now
      )
      return !shouldSuppressTerminalImeKeyboardEvent(keyboardEvent, {
        compositionActive,
        candidateKeyGuardActive: false,
        pendingCandidateKeyReleaseActive: false,
        pendingCompositionDeletionReleaseActive,
        isMac: false,
        isLinux: false
      })
    })
    await new Promise<void>((resolve) => terminal.write('\x1b[>10u', resolve))
    start(textarea, 'm')
    await nextEventLoop()

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'Backspace',
        keyCode: 229,
        bubbles: true,
        cancelable: true
      })
    )
    composition(textarea, 'compositionupdate', '')
    textarea.value = ''
    textarea.setSelectionRange(0, 0)
    composition(textarea, 'compositionend', '')
    textarea.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Process',
        code: 'Backspace',
        keyCode: 229,
        bubbles: true
      })
    )
    textarea.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        bubbles: true
      })
    )
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('edits only the active preedit when Windows IME deletion arrives as keyCode 229', async () => {
    const cases = [
      { eventKey: 'Process', code: 'Backspace', caret: 2, expected: 'n' },
      { eventKey: 'Process', code: 'Delete', caret: 0, expected: 'i' },
      { eventKey: 'Backspace', code: '', caret: 2, expected: 'n' }
    ] as const

    for (const testCase of cases) {
      const { emitted, terminal, textarea } = openTerminal(TerminalType)
      start(textarea, 'ni')
      await nextEventLoop()
      textarea.setSelectionRange(testCase.caret, testCase.caret)

      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: testCase.eventKey,
          code: testCase.code,
          keyCode: 229,
          bubbles: true,
          cancelable: true
        })
      )
      await nextEventLoop()

      const compositionView = terminal.element?.querySelector<HTMLElement>('.composition-view')
      expect(compositionView?.textContent?.replaceAll('\u200e', '')).toBe(testCase.expected)
      expect(textarea.value).toBe(testCase.expected)
      expect(emitted).toEqual([])
      terminal.dispose()
    }
  })

  it('expires deferred deletion ownership before a later empty composition update', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    start(textarea, 'ni')
    await nextEventLoop()

    const dispatchBackspace = (): void => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Process',
          code: 'Backspace',
          keyCode: 229,
          bubbles: true,
          cancelable: true
        })
      )
    }

    dispatchBackspace()
    await nextEventLoop()
    expect(textarea.value).toBe('n')

    composition(textarea, 'compositionupdate', '')
    dispatchBackspace()
    await nextEventLoop()

    expect(textarea.value).toBe('')
    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('prefers native IME progress over deferred deletion reconciliation', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    start(textarea, 'm')
    await nextEventLoop()

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'Backspace',
        keyCode: 229,
        bubbles: true,
        cancelable: true
      })
    )
    composition(textarea, 'compositionupdate', 'ma')
    textarea.value = 'ma'
    textarea.setSelectionRange(2, 2)
    await nextEventLoop()

    const compositionView = terminal.element?.querySelector<HTMLElement>('.composition-view')
    expect(compositionView?.textContent?.replaceAll('\u200e', '')).toBe('ma')
    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('bounds tracked timers during same-task transaction bursts', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    let maximumTimerCount = 0
    for (let index = 0; index < 256; index++) {
      start(textarea, '가')
      composition(textarea, 'compositionend', '가')
      maximumTimerCount = Math.max(maximumTimerCount, compositionState(terminal).timers.size)
    }
    await nextEventLoop()

    expect(emitted.join('')).toBe('가'.repeat(256))
    expect(maximumTimerCount).toBeLessThanOrEqual(4)
    expect(compositionState(terminal).timers.size).toBe(0)
    terminal.dispose()
  })

  it('keeps newer timer slots when canceled callbacks are forced', () => {
    const { terminal, textarea } = openTerminal(TerminalType)
    const callbacks: (() => void)[] = []
    const cleared = new Set<object>()
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      const token = {}
      callbacks.push(() => {
        if (!cleared.has(token)) {
          callback()
        }
      })
      return token
    }) as typeof setTimeout)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((token: object) => {
      cleared.add(token)
    }) as typeof clearTimeout)

    start(textarea, 'A')
    const oldState = compositionState(terminal)
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionend', 'A')
    const staleEndTimer = compositionState(terminal).endTimer
    composition(textarea, 'compositionupdate', 'B')
    const newState = compositionState(terminal)
    for (const callback of callbacks) {
      callback()
    }

    expect(cleared).toContain(oldState.positionTimer)
    expect(cleared).toContain(oldState.viewTimer)
    expect(cleared).toContain(staleEndTimer)
    expect(newState.positionTimer).not.toBe(oldState.positionTimer)
    expect(newState.viewTimer).not.toBe(oldState.viewTimer)
    expect(compositionState(terminal).positionTimer).toBe(newState.positionTimer)
    expect(compositionState(terminal).viewTimer).toBe(newState.viewTimer)
    expect(compositionState(terminal).timers.size).toBe(0)
    terminal.dispose()
  })
})
