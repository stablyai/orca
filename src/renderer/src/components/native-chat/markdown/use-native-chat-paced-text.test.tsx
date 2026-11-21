// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it } from 'vitest'
import { useNativeChatPacedText } from './use-native-chat-paced-text'
import { NativeChatHeldTextSessionContext } from './native-chat-reply-reveals'
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
