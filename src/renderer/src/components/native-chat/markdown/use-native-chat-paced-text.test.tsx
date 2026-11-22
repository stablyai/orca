// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { useNativeChatPacedText } from './use-native-chat-paced-text'
import {
  NativeChatHeldTextSessionContext,
  NativeChatReplyRevealsContext
} from './native-chat-reply-reveals'
import { createNativeChatReplyRevealTracker } from '../../../../../shared/native-chat/transcript/row-content/native-chat-reply-reveals'
import { documentViewerVisibility } from '../session/structured/read/document-viewer-visibility'

function renderReply(chat: string) {
  const root = { current: null }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NativeChatHeldTextSessionContext.Provider value={chat}>
      {children}
    </NativeChatHeldTextSessionContext.Provider>
  )
  return renderHook(({ text }) => useNativeChatPacedText('reply', text, true, root), {
    initialProps: { text: 'The reply so far.' },
    wrapper
  })
}

const held = `The reply so far. ${'and much more text that arrived while the window was minimized '.repeat(40)}`

it('draws text its chat held while the window was hidden at once, without fading it in', () => {
  const { result, rerender } = renderReply('chat-a')
  act(() => {
    documentViewerVisibility('chat-a').heldDrawn?.()
  })
  rerender({ text: held })
  expect(result.current.text).toBe(held)
  expect(result.current.fadeFrom ?? held.length).toBe(held.length)
})

it('keeps revealing a reply whose chat held nothing, while another chat catches up', () => {
  const { result, rerender } = renderReply('chat-c')
  act(() => {
    documentViewerVisibility('chat-d').heldDrawn?.()
  })
  rerender({ text: held })
  expect(result.current.text.length).toBeLessThan(held.length)
})

it('shows a reply redrawn whole only at its saves, revealed as main reveals them', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  try {
    const { reveals } = createNativeChatReplyRevealTracker()
    reveals.drawn.set('reply', { source: 'one', shown: 3, arrivals: [], drawsWhole: true })
    const root = { current: null }
    const { result, rerender } = renderHook(
      ({ text, revision }) => useNativeChatPacedText('reply', text, true, root, revision),
      {
        initialProps: { text: 'one', revision: 1 },
        wrapper: ({ children }: { children: ReactNode }) => (
          <NativeChatReplyRevealsContext.Provider value={reveals}>
            {children}
          </NativeChatReplyRevealsContext.Provider>
        )
      }
    )
    // Live text at the same revision waits for its save.
    rerender({ text: 'one two three', revision: 1 })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.text).toBe('one')
    // A save is revealed over main's 350 ms, then shown whole.
    rerender({ text: 'one two three four', revision: 2 })
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.text.length).toBeGreaterThan(3)
    expect(result.current.text.length).toBeLessThan(18)
    act(() => vi.advanceTimersByTime(300))
    expect(result.current.text).toBe('one two three four')
    expect(result.current.fadeFrom).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})
