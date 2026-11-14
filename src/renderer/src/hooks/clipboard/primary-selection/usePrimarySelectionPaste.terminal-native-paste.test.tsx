// @vitest-environment happy-dom

// Use real primary-selection state to prove terminal middle-click suppression is single-shot; sibling mocks cannot verify it.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  armPrimarySelectionNativePasteSuppression,
  resetPrimarySelectionForTests
} from '@/lib/clipboard/primary-selection/primary-selection'
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
})
