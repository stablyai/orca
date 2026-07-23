// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readPrimarySelectionText,
  shouldSuppressPrimarySelectionNativePaste
} from '@/lib/primary-selection'
import { usePrimarySelectionPaste } from './usePrimarySelectionPaste'

vi.mock('@/lib/primary-selection', () => ({
  readPrimarySelectionText: vi.fn(),
  setPrimarySelectionEnabled: vi.fn(),
  setPrimarySelectionText: vi.fn(),
  shouldSuppressPrimarySelectionNativePaste: vi.fn(() => false)
}))

const originalUserAgent = navigator.userAgent
const readPrimarySelectionTextMock = vi.mocked(readPrimarySelectionText)
const shouldSuppressNativePasteMock = vi.mocked(shouldSuppressPrimarySelectionNativePaste)

let root: Root | null = null
let container: HTMLDivElement | null = null

function Probe(): null {
  usePrimarySelectionPaste(true)
  return null
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: userAgent
  })
}

function appendTextarea(value = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.value = value
  document.body.appendChild(textarea)
  return textarea
}

function appendXtermHelperTextarea(): HTMLTextAreaElement {
  // Stand-in for xterm's hidden helper textarea inside its `.xterm` container.
  const terminal = document.createElement('div')
  terminal.className = 'xterm'
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  terminal.appendChild(textarea)
  document.body.appendChild(terminal)
  return textarea
}

function dispatchMiddleMouseDown(target: HTMLElement): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, button: 1, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function dispatchMiddleMouseUp(target: HTMLElement): MouseEvent {
  const event = new MouseEvent('mouseup', {
    bubbles: true,
    button: 1,
    cancelable: true,
    clientX: 4,
    clientY: 8
  })
  target.dispatchEvent(event)
  return event
}

function dispatchMiddleAuxClick(target: HTMLElement): MouseEvent {
  const event = new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function dispatchNativePasteBeforeInput(target: HTMLElement): Event {
  const event =
    typeof InputEvent === 'function'
      ? new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data: 'native',
          inputType: 'insertFromPaste'
        })
      : new Event('beforeinput', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function dispatchMiddleClick(target: HTMLElement): void {
  dispatchMiddleMouseDown(target)
  dispatchMiddleMouseUp(target)
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function renderProbe(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe />)
  })
}

beforeEach(() => {
  setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
  shouldSuppressNativePasteMock.mockReturnValue(false)
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
  document.body.replaceChildren()
  setUserAgent(originalUserAgent)
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('usePrimarySelectionPaste', () => {
  it('pastes resolved primary-selection text into the focused middle-click target', async () => {
    readPrimarySelectionTextMock.mockResolvedValue('beta')
    await renderProbe()
    const textarea = appendTextarea('alpha omega')
    textarea.focus()
    textarea.setSelectionRange(6, 11)

    await act(async () => {
      dispatchMiddleClick(textarea)
      await flushPromises()
    })

    expect(readPrimarySelectionTextMock).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('alpha beta')
    expect(document.activeElement).toBe(textarea)
  })

  it('does not paste when focus leaves before the async primary-selection read resolves', async () => {
    const deferredSelection = createDeferred<string>()
    readPrimarySelectionTextMock.mockReturnValue(deferredSelection.promise)
    await renderProbe()
    const staleTarget = appendTextarea('unchanged')
    const currentTarget = appendTextarea('current')
    staleTarget.focus()

    await act(async () => {
      dispatchMiddleClick(staleTarget)
    })
    currentTarget.focus()

    await act(async () => {
      deferredSelection.resolve('stale text')
      await flushPromises()
    })

    expect(readPrimarySelectionTextMock).toHaveBeenCalledTimes(1)
    expect(staleTarget.value).toBe('unchanged')
    expect(currentTarget.value).toBe('current')
    expect(document.activeElement).toBe(currentTarget)
  })

  it('owns Linux middle-click paste for editable DOM targets', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    readPrimarySelectionTextMock.mockResolvedValue('beta')
    await renderProbe()
    const textarea = appendTextarea('alpha omega')
    textarea.focus()
    textarea.setSelectionRange(6, 11)
    let nativeBeforeInput!: Event
    let mouseUp!: MouseEvent
    let auxClick!: MouseEvent

    await act(async () => {
      dispatchMiddleMouseDown(textarea)
      nativeBeforeInput = dispatchNativePasteBeforeInput(textarea)
      mouseUp = dispatchMiddleMouseUp(textarea)
      auxClick = dispatchMiddleAuxClick(textarea)
      await flushPromises()
    })

    expect(nativeBeforeInput.defaultPrevented).toBe(true)
    expect(mouseUp.defaultPrevented).toBe(true)
    expect(auxClick.defaultPrevented).toBe(true)
    expect(readPrimarySelectionTextMock).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('alpha beta')
  })

  it('swallows terminal-armed native paste follow-up even when it has no pending DOM target', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    shouldSuppressNativePasteMock.mockReturnValue(true)
    await renderProbe()
    // Stand-in for xterm's helper textarea, which owns its own middle-click
    // paste and never registers a pending primary-selection DOM target.
    const terminalTextarea = appendXtermHelperTextarea()
    let nativeBeforeInput!: Event
    const nativePaste = new Event('paste', { bubbles: true, cancelable: true })

    await act(async () => {
      nativeBeforeInput = dispatchNativePasteBeforeInput(terminalTextarea)
      terminalTextarea.dispatchEvent(nativePaste)
      await flushPromises()
    })

    expect(nativeBeforeInput.defaultPrevented).toBe(true)
    expect(nativePaste.defaultPrevented).toBe(true)
    expect(readPrimarySelectionTextMock).not.toHaveBeenCalled()
  })

  it('does not suppress an unrelated document paste while the terminal window is armed', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    // Armed window is active, but the paste targets a control outside the
    // terminal (e.g. right-click Paste into a form field) and must survive.
    shouldSuppressNativePasteMock.mockReturnValue(true)
    await renderProbe()
    const unrelatedTextarea = appendTextarea()
    let nativeBeforeInput!: Event
    const nativePaste = new Event('paste', { bubbles: true, cancelable: true })

    await act(async () => {
      nativeBeforeInput = dispatchNativePasteBeforeInput(unrelatedTextarea)
      unrelatedTextarea.dispatchEvent(nativePaste)
      await flushPromises()
    })

    expect(nativeBeforeInput.defaultPrevented).toBe(false)
    expect(nativePaste.defaultPrevented).toBe(false)
  })

  it('does not suppress native paste when the terminal has not armed the window', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    shouldSuppressNativePasteMock.mockReturnValue(false)
    await renderProbe()
    const textarea = appendTextarea()

    let nativeBeforeInput!: Event
    await act(async () => {
      nativeBeforeInput = dispatchNativePasteBeforeInput(textarea)
      await flushPromises()
    })

    expect(nativeBeforeInput.defaultPrevented).toBe(false)
  })

  it('does not keep middle-click ownership after the gesture window expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    readPrimarySelectionTextMock.mockResolvedValue('late')
    await renderProbe()
    const textarea = appendTextarea('unchanged')
    textarea.focus()

    dispatchMiddleMouseDown(textarea)
    vi.setSystemTime(1_751)
    const mouseUp = dispatchMiddleMouseUp(textarea)
    await flushPromises()

    expect(mouseUp.defaultPrevented).toBe(false)
    expect(readPrimarySelectionTextMock).not.toHaveBeenCalled()
    expect(textarea.value).toBe('unchanged')
  })
})
