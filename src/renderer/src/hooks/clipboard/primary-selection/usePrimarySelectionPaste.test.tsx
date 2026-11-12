// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumePrimarySelectionNativePasteSuppression,
  readPrimarySelectionText
} from '@/lib/clipboard/primary-selection/primary-selection'
import { usePrimarySelectionPaste } from './usePrimarySelectionPaste'

vi.mock('@/lib/clipboard/primary-selection/primary-selection', () => ({
  consumePrimarySelectionNativePasteSuppression: vi.fn(() => false),
  readPrimarySelectionText: vi.fn(),
  setPrimarySelectionEnabled: vi.fn(),
  setPrimarySelectionText: vi.fn()
}))

const originalUserAgent = navigator.userAgent
const readPrimarySelectionTextMock = vi.mocked(readPrimarySelectionText)
const consumeNativePasteMock = vi.mocked(consumePrimarySelectionNativePasteSuppression)

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
  consumeNativePasteMock.mockReturnValue(false)
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
})

describe('usePrimarySelectionPaste', () => {
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
})
