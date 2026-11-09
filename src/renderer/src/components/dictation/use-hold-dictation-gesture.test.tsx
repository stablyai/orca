// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationState } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings, getDefaultVoiceSettings } from '../../../../shared/constants'
import { useHoldDictationGesture } from './use-hold-dictation-gesture'

const originalUserAgent = navigator.userAgent

let root: Root | null = null
let container: HTMLDivElement | null = null
let dictationState: DictationState
let dictationMode: 'auto' | 'hold'
let terminalShortcutPolicy: 'orca-first' | 'terminal-first'
let startDictation: ReturnType<typeof vi.fn<() => void>>
let stopDictation: ReturnType<typeof vi.fn<() => void>>

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: userAgent
  })
}

function holdSettings(): GlobalSettings {
  return {
    ...getDefaultSettings('/home/test'),
    terminalShortcutPolicy,
    voice: { ...getDefaultVoiceSettings(), enabled: true, sttModel: 'test-model', dictationMode }
  }
}

function Probe(): null {
  useHoldDictationGesture({
    canStartDictation: () => dictationState === 'idle',
    keybindings: {},
    settings: holdSettings(),
    startDictation,
    stopDictation
  })
  return null
}

function dispatchKeyDown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

function dispatchKeyUp(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

async function renderProbe(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe />)
  })
}

function beginHold(init: KeyboardEventInit = {}): void {
  act(() => {
    dispatchKeyDown({ key: 'e', code: 'KeyE', metaKey: true, ...init })
  })
  dictationState = 'listening'
}

beforeEach(() => {
  setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
  dictationState = 'idle'
  dictationMode = 'hold'
  terminalShortcutPolicy = 'orca-first'
  startDictation = vi.fn<() => void>()
  stopDictation = vi.fn<() => void>()
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  setUserAgent(originalUserAgent)
  vi.clearAllMocks()
})

describe('useHoldDictationGesture', () => {
  it('stops after a layout-aware shortcut key release drops the modifier flag', async () => {
    await renderProbe()

    beginHold({ key: 'e', code: 'KeyD' })

    act(() => {
      dispatchKeyUp({ key: 'e', code: 'KeyD', metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
  })

  it('stops when the required modifier is released before the shortcut key', async () => {
    await renderProbe()

    beginHold()

    act(() => {
      dispatchKeyUp({ key: 'Meta', code: 'MetaLeft', metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
  })

  it('keeps a held dictation when its callbacks and keybindings are re-created', async () => {
    await renderProbe()

    beginHold()

    const firstStopDictation = stopDictation
    startDictation = vi.fn<() => void>()
    stopDictation = vi.fn<() => void>()
    await act(async () => {
      root?.render(<Probe />)
    })

    expect(firstStopDictation).not.toHaveBeenCalled()
    expect(stopDictation).not.toHaveBeenCalled()

    act(() => {
      dispatchKeyUp({ key: 'e', code: 'KeyE', metaKey: false })
    })

    expect(stopDictation).toHaveBeenCalledTimes(1)
  })

  it('does not restart from key repeat after dictation stopped on its own', async () => {
    await renderProbe()

    beginHold()
    dictationState = 'idle'

    act(() => {
      dispatchKeyDown({ key: 'e', code: 'KeyE', metaKey: true, repeat: true })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
  })
})

describe('useHoldDictationGesture in Auto mode', () => {
  let now = 0

  beforeEach(() => {
    dictationMode = 'auto'
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })

  it('keeps recording after a tap and stops on the next press', async () => {
    await renderProbe()

    beginHold()
    now += 299
    act(() => {
      dispatchKeyUp({ key: 'e', code: 'KeyE', metaKey: true })
    })
    expect(stopDictation).not.toHaveBeenCalled()

    act(() => {
      dispatchKeyDown({ key: 'e', code: 'KeyE', metaKey: true })
    })
    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
  })

  it('stops on release after a press held for 300 ms', async () => {
    await renderProbe()

    beginHold()
    act(() => {
      dispatchKeyDown({ key: 'e', code: 'KeyE', metaKey: true, repeat: true })
    })
    now += 300
    act(() => {
      dispatchKeyUp({ key: 'Meta', code: 'MetaLeft', metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
  })

  it('leaves the shortcut to the IME while composing', async () => {
    await renderProbe()

    const event = dispatchKeyDown({ key: 'e', code: 'KeyE', metaKey: true, isComposing: true })

    expect(event.defaultPrevented).toBe(false)
    expect(startDictation).not.toHaveBeenCalled()
  })

  it('leaves the shortcut to a terminal that owns its keys', async () => {
    terminalShortcutPolicy = 'terminal-first'
    await renderProbe()
    const terminalInput = document.createElement('textarea')
    terminalInput.className = 'xterm-helper-textarea'
    document.body.appendChild(terminalInput)

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'e',
      code: 'KeyE',
      metaKey: true
    })
    act(() => {
      terminalInput.dispatchEvent(event)
    })
    terminalInput.remove()

    expect(event.defaultPrevented).toBe(false)
    expect(startDictation).not.toHaveBeenCalled()
  })
})
