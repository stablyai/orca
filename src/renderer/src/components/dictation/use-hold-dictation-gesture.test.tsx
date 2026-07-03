// @vitest-environment happy-dom

import { createRef, type MutableRefObject } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationState } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/types'
import type { DictationInsertionTarget } from './dictation-insertion-target'
import { useHoldDictationGesture } from './use-hold-dictation-gesture'

const originalUserAgent = navigator.userAgent

let root: Root | null = null
let container: HTMLDivElement | null = null
let dictationStateRef: MutableRefObject<DictationState>
let holdGestureActiveRef: MutableRefObject<boolean>
let insertionTargetRef: MutableRefObject<DictationInsertionTarget | null>
let intentionalTargetCancellationRef: MutableRefObject<boolean>
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
    voice: {
      enabled: true,
      sttModel: 'test-model',
      dictationMode: 'hold'
    }
  } as GlobalSettings
}

function Probe(): null {
  useHoldDictationGesture({
    dictationStateRef,
    holdGestureActiveRef,
    insertionTargetRef,
    intentionalTargetCancellationRef,
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
  dictationStateRef.current = 'listening'
}

beforeEach(() => {
  setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
  dictationStateRef = createRef<DictationState>() as MutableRefObject<DictationState>
  dictationStateRef.current = 'idle'
  holdGestureActiveRef = createRef<boolean>() as MutableRefObject<boolean>
  holdGestureActiveRef.current = false
  insertionTargetRef = createRef<DictationInsertionTarget | null>()
  insertionTargetRef.current = null
  intentionalTargetCancellationRef = createRef<boolean>() as MutableRefObject<boolean>
  intentionalTargetCancellationRef.current = false
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
  it('stops when the shortcut key is released after the modifier', async () => {
    await renderProbe()

    beginHold()

    act(() => {
      dispatchKeyUp({ key: 'e', code: 'KeyE', metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
    expect(holdGestureActiveRef.current).toBe(false)
  })

  it('stops after a layout-aware shortcut key release drops the modifier flag', async () => {
    await renderProbe()

    beginHold({ key: 'e', code: 'KeyD' })

    act(() => {
      dispatchKeyUp({ key: 'e', code: 'KeyD', metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
    expect(holdGestureActiveRef.current).toBe(false)
  })

  it('stops when the required modifier is released before the shortcut key', async () => {
    await renderProbe()

    beginHold()

    act(() => {
      dispatchKeyUp({ key: 'Meta', code: 'MetaLeft', metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
    expect(holdGestureActiveRef.current).toBe(false)
  })

  it('ignores unrelated key releases while the shortcut is held', async () => {
    await renderProbe()

    beginHold()

    act(() => {
      dispatchKeyUp({ key: 'x', code: 'KeyX', metaKey: true })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).not.toHaveBeenCalled()
    expect(holdGestureActiveRef.current).toBe(true)
  })

  it('ignores modifier releases that were not part of the accepted chord', async () => {
    await renderProbe()

    beginHold()

    act(() => {
      dispatchKeyUp({ key: 'Shift', code: 'ShiftLeft', metaKey: true, shiftKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).not.toHaveBeenCalled()
    expect(holdGestureActiveRef.current).toBe(true)
  })

  it('falls back to key identity when the accepted keydown has no code', async () => {
    await renderProbe()

    beginHold({ code: '' })

    act(() => {
      dispatchKeyUp({ key: 'a', code: '', metaKey: true })
    })

    expect(stopDictation).not.toHaveBeenCalled()
    expect(holdGestureActiveRef.current).toBe(true)

    act(() => {
      dispatchKeyUp({ key: 'e', code: '', metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
    expect(holdGestureActiveRef.current).toBe(false)
  })

  it('falls back to key identity when the release has no code', async () => {
    await renderProbe()

    beginHold()

    act(() => {
      dispatchKeyUp({ key: 'e', code: '', metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
    expect(holdGestureActiveRef.current).toBe(false)
  })

  it('stops on non-Mac when the shortcut key is released after Ctrl has dropped', async () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    await renderProbe()

    beginHold({ ctrlKey: true, metaKey: false })

    act(() => {
      dispatchKeyUp({ key: 'e', code: 'KeyE', ctrlKey: false, metaKey: false })
    })

    expect(startDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledTimes(1)
    expect(holdGestureActiveRef.current).toBe(false)
  })
})
