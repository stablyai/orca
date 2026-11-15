// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const speak = vi.hoisted(() => vi.fn())
vi.mock('./native-chat-speech-session', () => ({
  speakNativeChatMessage: speak
}))

import { publishNativeChatSpeechPreferences } from './native-chat-speech-preferences'
import { useNativeChatAutoSpeech } from './use-native-chat-auto-speech'

afterEach(() => {
  speak.mockReset()
  publishNativeChatSpeechPreferences(undefined)
  vi.useRealTimers()
})

describe('automatic speech', () => {
  it('reads the result only after that turn stops', () => {
    vi.useFakeTimers()
    publishNativeChatSpeechPreferences({ auto: true })
    const { rerender } = renderHook(
      ({ answer, working, markdown }: { answer: boolean; working: boolean; markdown: string }) =>
        useNativeChatAutoSpeech({ messageId: 'message', markdown, answer, working }),
      { initialProps: { answer: true, working: false, markdown: 'Уже на экране' } }
    )
    vi.advanceTimersByTime(500)
    expect(speak).not.toHaveBeenCalled()

    rerender({ answer: true, working: true, markdown: 'Пишу' })
    rerender({ answer: true, working: false, markdown: 'Готово' })
    expect(speak).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(speak).toHaveBeenCalledWith({
      messageId: 'message',
      markdown: 'Готово',
      settings: expect.objectContaining({ auto: true, engine: 'web-speech' })
    })
  })

  it('stays quiet when a later step takes the result while the turn is still working', () => {
    vi.useFakeTimers()
    publishNativeChatSpeechPreferences({ auto: true })
    const { rerender } = renderHook(
      ({ answer, working }: { answer: boolean; working: boolean }) =>
        useNativeChatAutoSpeech({
          messageId: 'message',
          markdown: 'Промежуточное',
          answer,
          working
        }),
      { initialProps: { answer: true, working: true } }
    )
    rerender({ answer: false, working: true })
    vi.advanceTimersByTime(500)
    expect(speak).not.toHaveBeenCalled()
  })

  it('stays quiet when automatic reading is off', () => {
    vi.useFakeTimers()
    const { rerender } = renderHook(
      ({ working }: { working: boolean }) =>
        useNativeChatAutoSpeech({
          messageId: 'message',
          markdown: 'Готово',
          answer: true,
          working
        }),
      { initialProps: { working: true } }
    )
    rerender({ working: false })
    vi.advanceTimersByTime(500)
    expect(speak).not.toHaveBeenCalled()
  })
})
