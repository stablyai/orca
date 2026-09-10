// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useNativeChatComposerRevealFocus } from './use-native-chat-composer-reveal-focus'
import type { NativeChatComposerHandle } from './NativeChatComposer'

type HarnessProps = {
  isVisible: boolean
  isFocusedGroup: boolean
  composerReady?: boolean
  /** Composer handle is unavailable until this many focus attempts have run. */
  readyAfterAttempts?: number
  onFocus?: () => void
  /** Rerender-only churn, to prove the latch holds. */
  nonce?: number
}

let container: HTMLDivElement
let root: Root
let frames: (() => void)[] = []
let focusCalls = 0

/** Drain queued frames; each drained frame may queue the next. */
function drainFrames(max = 20): void {
  for (let i = 0; i < max && frames.length > 0; i += 1) {
    const queued = frames
    frames = []
    act(() => {
      for (const frame of queued) {
        frame()
      }
    })
  }
}

function Harness(props: HarnessProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const attemptsRef = useRef(0)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  composerRef.current = {
    focus: () => {
      attemptsRef.current += 1
      focusCalls += 1
      props.onFocus?.()
      if (attemptsRef.current <= (props.readyAfterAttempts ?? 0)) {
        return false
      }
      fieldRef.current?.focus()
      return true
    },
    insertTypedText: () => true,
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {}
  } as NativeChatComposerHandle
  useNativeChatComposerRevealFocus({
    rootRef,
    composerRef,
    isVisible: props.isVisible,
    isFocusedGroup: props.isFocusedGroup,
    composerReady: props.composerReady ?? true,
    scheduleFrame: (callback) => {
      frames.push(callback)
    }
  })
  return createElement(
    'div',
    { ref: rootRef },
    createElement('textarea', { ref: fieldRef, 'data-testid': 'composer' }),
    createElement('button', { type: 'button', 'data-testid': 'in-pane-button' })
  )
}

function render(props: HarnessProps): void {
  act(() => {
    root.render(createElement(Harness, props))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  frames = []
  focusCalls = 0
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

describe('useNativeChatComposerRevealFocus', () => {
  it('focuses when it mounts already revealed', () => {
    render({ isVisible: true, isFocusedGroup: true })
    expect(focusCalls).toBe(0)
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('focuses on the isVisible edge', () => {
    render({ isVisible: false, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(0)
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(1)
  })

  it('focuses on the isFocusedGroup edge alone', () => {
    render({ isVisible: true, isFocusedGroup: false })
    drainFrames()
    expect(focusCalls).toBe(0)
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(1)
  })

  it('lets only the focused group claim when two panes are revealed together', () => {
    const other = document.createElement('div')
    document.body.appendChild(other)
    const otherRoot = createRoot(other)
    act(() => {
      root.render(createElement(Harness, { isVisible: true, isFocusedGroup: true }))
      otherRoot.render(createElement(Harness, { isVisible: true, isFocusedGroup: false }))
    })
    drainFrames()
    expect(focusCalls).toBe(1)
    act(() => {
      otherRoot.unmount()
    })
    other.remove()
  })

  it('holds the latch across unrelated rerenders', () => {
    render({ isVisible: true, isFocusedGroup: true, nonce: 1 })
    drainFrames()
    expect(focusCalls).toBe(1)
    render({ isVisible: true, isFocusedGroup: true, nonce: 2 })
    render({ isVisible: true, isFocusedGroup: true, nonce: 3 })
    drainFrames()
    expect(focusCalls).toBe(1)
  })

  // A button is neither inside-pane-focus nor an editable field, so only the latch can stop this.
  it('does not chase focus the user moved to a control outside the pane', () => {
    render({ isVisible: true, isFocusedGroup: true, nonce: 1 })
    drainFrames()
    expect(focusCalls).toBe(1)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    act(() => {
      outside.focus()
    })
    render({ isVisible: true, isFocusedGroup: true, nonce: 2 })
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  // Non-editable, so only the inside-the-pane check can stop this one.
  it('leaves focus on a non-editable control inside the pane', () => {
    render({ isVisible: false, isFocusedGroup: true })
    const button = container.querySelector('button')
    act(() => {
      button?.focus()
    })
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(0)
    expect(document.activeElement).toBe(button)
  })

  it('re-arms after the pane is hidden and revealed again', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    render({ isVisible: false, isFocusedGroup: true })
    drainFrames()
    act(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(2)
  })

  it('retries across frames until the composer takes focus', () => {
    render({ isVisible: true, isFocusedGroup: true, readyAfterAttempts: 2 })
    drainFrames()
    expect(focusCalls).toBe(3)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('gives up after a bounded number of attempts', () => {
    render({ isVisible: true, isFocusedGroup: true, readyAfterAttempts: 99 })
    drainFrames()
    expect(focusCalls).toBe(6)
  })

  it('waits for a composer that is not ready yet, then focuses', () => {
    render({ isVisible: true, isFocusedGroup: true, composerReady: false })
    drainFrames()
    expect(focusCalls).toBe(0)
    render({ isVisible: true, isFocusedGroup: true, composerReady: true })
    drainFrames()
    expect(focusCalls).toBe(1)
  })

  it('leaves focus alone when it is already inside the pane', () => {
    render({ isVisible: false, isFocusedGroup: true })
    const field = container.querySelector('textarea')
    act(() => {
      field?.focus()
    })
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(0)
  })

  it('leaves a live text field outside the pane alone', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(0)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('still claims focus from the covered xterm helper textarea', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    document.body.appendChild(helper)
    helper.focus()
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
    helper.remove()
  })
})
