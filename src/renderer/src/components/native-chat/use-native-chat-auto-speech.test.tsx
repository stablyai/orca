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
  it('reads a reply only after that reply stops arriving', () => {
    vi.useFakeTimers()
    publishNativeChatSpeechPreferences({ auto: true })
    const { rerender } = renderHook(
      ({ live, markdown }: { live: boolean; markdown: string }) =>
        useNativeChatAutoSpeech({ messageId: 'message', markdown, live }),
      { initialProps: { live: false, markdown: 'Уже на экране' } }
    )
    vi.advanceTimersByTime(500)
    expect(speak).not.toHaveBeenCalled()

    rerender({ live: true, markdown: 'Пишу' })
    rerender({ live: false, markdown: 'Готово' })
    expect(speak).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(speak).toHaveBeenCalledWith({
      messageId: 'message',
      markdown: 'Готово',
      settings: expect.objectContaining({ auto: true, engine: 'web-speech' })
    })
  })

  it('stays quiet when automatic reading is off', () => {
    vi.useFakeTimers()
    const { rerender } = renderHook(
      ({ live }: { live: boolean }) =>
        useNativeChatAutoSpeech({ messageId: 'message', markdown: 'Готово', live }),
      { initialProps: { live: true } }
    )
    rerender({ live: false })
    vi.advanceTimersByTime(500)
    expect(speak).not.toHaveBeenCalled()
  })
})
