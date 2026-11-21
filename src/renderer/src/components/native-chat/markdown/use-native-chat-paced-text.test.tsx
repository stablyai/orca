// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useNativeChatPacedText } from './use-native-chat-paced-text'
import { documentViewerVisibility } from '../session/structured/read/document-viewer-visibility'

it('draws text held while the window was hidden at once, without fading it in', () => {
  const root = { current: null }
  const first = 'The reply so far.'
  const held = `${first} ${'and much more text that arrived while the window was minimized '.repeat(40)}`
  const { result, rerender } = renderHook(
    ({ text }) => useNativeChatPacedText('reply', text, true, root),
    { initialProps: { text: first } }
  )
  act(() => {
    documentViewerVisibility.heldDrawn?.()
  })
  rerender({ text: held })
  expect(result.current.text).toBe(held)
  expect(result.current.fadeFrom ?? held.length).toBe(held.length)
})
