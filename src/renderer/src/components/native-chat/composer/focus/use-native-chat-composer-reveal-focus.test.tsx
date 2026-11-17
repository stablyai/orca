// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import { useNativeChatComposerRevealFocus } from './use-native-chat-composer-reveal-focus'
import { requestNativeChatComposerFocus } from './native-chat-composer-focus-intent'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let container: HTMLDivElement
let sidebar: HTMLDivElement
let prompt: boolean
const frames: (() => void)[] = []
const scheduleFrame = (callback: () => void) => frames.push(callback)
function Probe() {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>({
    insertAgentReferences: () => false,
    insertTypedText: () => false,
    acceptsText: () => true,
    contains: (element) => rootRef.current?.contains(element) === true,
    appendText: () => {},
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    focus: () => {
      rootRef.current?.querySelector('textarea')?.focus()
      return true
    }
  })
  useNativeChatComposerRevealFocus({
    tabId: 'tab',
    rootRef,
    composerRef,
    isVisible: true,
    isFocusedGroup: true,
    composerReady: !prompt,
    surfaceReady: prompt,
    scheduleFrame
  })
  return (
    <div ref={rootRef} tabIndex={-1}>
      {prompt ? (
        <div data-native-chat-prompt-card-focus tabIndex={-1}>
          <button data-native-chat-prompt-card-focus-target>Approve</button>
        </div>
      ) : (
        <textarea />
      )}
    </div>
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  frames.length = 0
  container = document.createElement('div')
  sidebar = document.createElement('div')
  sidebar.tabIndex = 0
  sidebar.setAttribute('data-worktree-sidebar', '')
  sidebar.setAttribute('data-keyboard-navigation', '')
  document.body.append(container, sidebar)
  sidebar.focus()
  root = createRoot(container)
  prompt = false
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  sidebar.remove()
  vi.useRealTimers()
})
it('preserves selected sidebar focus on reveal and allows an explicit composer handoff', () => {
  act(() => root.render(<Probe />))
  act(() => {
    for (const callback of frames.splice(0)) {
      callback()
    }
  })
  expect(document.activeElement).toBe(sidebar)
  sidebar.removeAttribute('data-keyboard-navigation')
  act(() => requestNativeChatComposerFocus('tab'))
  expect(document.activeElement).toBe(container.querySelector('textarea'))
})
it('hands off to the actionable prompt card when there is no composer', () => {
  prompt = true
  act(() => root.render(<Probe />))
  expect(document.activeElement).toBe(sidebar)
  sidebar.removeAttribute('data-keyboard-navigation')
  act(() => requestNativeChatComposerFocus('tab'))
  expect(document.activeElement).toBe(container.querySelector('button'))
})
