// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import { requestNativeChatComposerFocus } from './native-chat-composer-focus-intent'
import { useNativeChatComposerRevealFocus } from './use-native-chat-composer-reveal-focus'

const TAB_ID = 'tab-chat'

describe('a composer focus requested with a condition', () => {
  let root: HTMLDivElement
  let input: HTMLTextAreaElement
  let outside: HTMLButtonElement
  let frames: (() => void)[]
  /** The composer cannot take focus yet (it is still settling), as after a late mount. */
  let focusHeld: boolean

  beforeEach(() => {
    root = document.createElement('div')
    input = document.createElement('textarea')
    root.appendChild(input)
    outside = document.createElement('button')
    document.body.append(root, outside)
    frames = []
    focusHeld = false
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  function composer(): NativeChatComposerHandle {
    return {
      insertAgentReferences: () => false,
      focus: () => {
        if (focusHeld) {
          return false
        }
        input.focus()
        return true
      },
      insertTypedText: () => false,
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: (node) => input.contains(node)
    }
  }

  function mountComposer() {
    const rootRef = { current: root }
    const composerRef = { current: composer() }
    const view = renderHook(() =>
      useNativeChatComposerRevealFocus({
        tabId: TAB_ID,
        rootRef,
        composerRef,
        isVisible: true,
        isFocusedGroup: true,
        composerReady: true,
        scheduleFrame: (callback) => void frames.push(callback)
      })
    )
    // The reveal's own claim lands, then the user puts focus back outside.
    flushFrames()
    outside.focus()
    return view
  }

  function flushFrames(): void {
    for (let guard = 0; guard < 20 && frames.length > 0; guard += 1) {
      const next = frames.shift()!
      act(() => next())
    }
  }

  /** Asks for the composer while it cannot take focus, then focus moves to a plain button. */
  function requestThenFocusOutside(stillWanted?: () => boolean): void {
    // Focus is nowhere when the request is delivered, so its condition holds then.
    outside.blur()
    focusHeld = true
    act(() => requestNativeChatComposerFocus(TAB_ID, stillWanted ? { stillWanted } : {}))
    expect(document.activeElement).toBe(document.body)
    outside.focus()
    focusHeld = false
    flushFrames()
  }

  it('stops retrying once its condition no longer holds', () => {
    const view = mountComposer()

    requestThenFocusOutside(() => document.activeElement === document.body)

    expect(document.activeElement).toBe(outside)
    view.unmount()
  })

  it('keeps retrying while its condition holds', () => {
    const view = mountComposer()

    requestThenFocusOutside(() => true)

    expect(document.activeElement).toBe(input)
    view.unmount()
  })

  it('keeps retrying for a caller that gives no condition', () => {
    const view = mountComposer()

    requestThenFocusOutside()

    expect(document.activeElement).toBe(input)
    view.unmount()
  })
})
