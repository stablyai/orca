// @vitest-environment happy-dom

// Use real primary-selection state to prove terminal middle-click suppression is single-shot; sibling mocks cannot verify it.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  armPrimarySelectionNativePasteSuppression,
  resetPrimarySelectionForTests
} from '@/lib/primary-selection'
import { usePrimarySelectionPaste } from './usePrimarySelectionPaste'

const originalUserAgent = navigator.userAgent

let root: Root | null = null
let container: HTMLDivElement | null = null

function Probe(): null {
  usePrimarySelectionPaste(true)
  return null
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

async function renderProbe(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe />)
  })
}

function appendXtermHelperTextarea(): HTMLTextAreaElement {
  const terminal = document.createElement('div')
  terminal.className = 'xterm'
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  terminal.appendChild(textarea)
  document.body.appendChild(terminal)
  return textarea
}

function dispatchPasteBeforeInput(target: HTMLElement): Event {
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: 'pasted',
    inputType: 'insertFromPaste'
  })
  target.dispatchEvent(event)
  return event
}

// xterm forwards paste, not beforeinput, so exercise the event that actually writes PTY bytes.
function dispatchClipboardPaste(target: HTMLElement): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  resetPrimarySelectionForTests()
  setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
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
  resetPrimarySelectionForTests()
})

describe('terminal-armed native paste suppression', () => {
  it('swallows the first follow-up paste but not a later real paste in the same window', async () => {
    await renderProbe()
    const terminalTextarea = appendXtermHelperTextarea()
    armPrimarySelectionNativePasteSuppression()
    let nativeFollowUp!: Event
    let keyboardPaste!: Event

    await act(async () => {
      nativeFollowUp = dispatchPasteBeforeInput(terminalTextarea)
      keyboardPaste = dispatchPasteBeforeInput(terminalTextarea)
    })

    expect(nativeFollowUp.defaultPrevented).toBe(true)
    expect(keyboardPaste.defaultPrevented).toBe(false)
  })

  it('swallows one clipboard paste per arm, the event xterm forwards to the PTY', async () => {
    await renderProbe()
    const terminalTextarea = appendXtermHelperTextarea()
    armPrimarySelectionNativePasteSuppression()
    let nativeFollowUp!: Event
    let keyboardPaste!: Event

    await act(async () => {
      nativeFollowUp = dispatchClipboardPaste(terminalTextarea)
      keyboardPaste = dispatchClipboardPaste(terminalTextarea)
    })

    expect(nativeFollowUp.defaultPrevented).toBe(true)
    expect(keyboardPaste.defaultPrevented).toBe(false)
  })

  it('keeps suppressing nothing when the terminal never armed the window', async () => {
    await renderProbe()
    const terminalTextarea = appendXtermHelperTextarea()

    let paste!: Event
    await act(async () => {
      paste = dispatchPasteBeforeInput(terminalTextarea)
    })

    expect(paste.defaultPrevented).toBe(false)
  })

  it('does not arm on macOS, where Chromium emits no native follow-up paste', async () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
    await renderProbe()
    const terminalTextarea = appendXtermHelperTextarea()
    armPrimarySelectionNativePasteSuppression()

    let paste!: Event
    await act(async () => {
      paste = dispatchPasteBeforeInput(terminalTextarea)
    })

    expect(paste.defaultPrevented).toBe(false)
  })
})
