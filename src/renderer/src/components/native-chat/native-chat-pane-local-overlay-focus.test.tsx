// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useRef, type RefObject } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileDriverOverlay } from '@/components/terminal-pane/MobileDriverOverlay'
import { BrowserMobileDriverOverlay } from '@/components/browser-pane/assemble-chrome/BrowserMobileDriverOverlay'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import {
  requestNativeChatComposerFocus,
  useNativeChatComposerRevealFocus
} from './use-native-chat-composer-reveal-focus'

let frames: (() => void)[] = []
const scheduleFrame = (callback: () => void): void => {
  frames.push(callback)
}
const noop = (): void => {}

afterEach(() => {
  document.dispatchEvent(new Event('pointerdown'))
  cleanup()
  frames = []
})

function drainFrames(): void {
  act(() => {
    while (frames.length) {
      const queued = frames
      frames = []
      queued.forEach((frame) => frame())
    }
  })
}

function Chat({
  inputRef,
  revealed
}: {
  inputRef: RefObject<NativeChatComposerInput | null>
  revealed: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const insertion = useNativeChatTypedInsertion({
    textareaRef: inputRef,
    isComposing: () => false,
    setDraft: noop,
    setCaret: noop,
    setActiveSuggestion: noop
  })
  const composerRef = useRef<NativeChatComposerHandle>({
    ...insertion,
    insertAgentReferences: () => false,
    handlePasteEvent: noop,
    pasteFromClipboard: noop
  })
  useNativeChatComposerRevealFocus({
    tabId: 'chat',
    rootRef,
    composerRef,
    isVisible: revealed,
    isFocusedGroup: true,
    composerReady: true,
    scheduleFrame
  })
  return (
    <div ref={rootRef}>
      <NativeChatPromptEditor
        inputRef={inputRef}
        initialValue=""
        disabled={false}
        placeholder="Message"
        onChange={noop}
        onSelect={noop}
      />
    </div>
  )
}

function Recovery({ browser }: { browser: boolean }) {
  return browser ? (
    <BrowserMobileDriverOverlay driver={{ kind: 'mobile', clientId: 'phone' }} onTakeBack={noop} />
  ) : (
    <MobileDriverOverlay driver={{ kind: 'idle' }} hasFitOverride onAction={noop} />
  )
}

function setup(browser: boolean, samePane = false) {
  const inputRef = createRef<NativeChatComposerInput>()
  function Split({ revealed }: { revealed: boolean }) {
    return (
      <TooltipProvider>
        <div>
          <Recovery browser={browser} />
          {samePane ? <Chat inputRef={inputRef} revealed={revealed} /> : null}
        </div>
        {!samePane ? <Chat inputRef={inputRef} revealed={revealed} /> : null}
        <button onClick={() => requestNativeChatComposerFocus('chat')}>Activate chat</button>
      </TooltipProvider>
    )
  }
  const view = render(<Split revealed={false} />)
  const restore = screen.getByRole('button', {
    name: browser ? 'Take back' : 'Restore'
  })
  act(() => restore.focus())
  return {
    inputRef,
    restore,
    reveal: () => view.rerender(<Split revealed />)
  }
}

describe.each([false, true])('chat focus beside phone recovery (browser: %s)', (browser) => {
  it('automatically focuses a revealed chat in another pane', () => {
    const chat = setup(browser)
    chat.reveal()
    drainFrames()

    expect(chat.inputRef.current?.contains?.(document.activeElement)).toBe(true)
    expect(chat.restore.isConnected).toBe(true)
  })

  it.each([false, true])(
    'activates chat without waiting for another pane’s Restore (already revealed: %s)',
    (revealed) => {
      const chat = setup(browser)
      if (revealed) {
        chat.reveal()
        drainFrames()
        act(() => chat.restore.focus())
      }
      fireEvent.click(screen.getByRole('button', { name: 'Activate chat' }))
      if (!revealed) {
        chat.reveal()
      }
      drainFrames()

      expect(chat.inputRef.current?.contains?.(document.activeElement)).toBe(true)
      expect(chat.restore.isConnected).toBe(true)
    }
  )

  it('allows a direct editor focus request from another pane', () => {
    const chat = setup(browser)

    act(() => chat.inputRef.current?.focus())

    expect(chat.inputRef.current?.contains?.(document.activeElement)).toBe(true)
  })

  it('keeps recovery ownership within its own pane', () => {
    const chat = setup(browser, true)
    chat.reveal()
    drainFrames()
    act(() => chat.inputRef.current?.focus())

    expect(document.activeElement).toBe(chat.restore)
  })
})
