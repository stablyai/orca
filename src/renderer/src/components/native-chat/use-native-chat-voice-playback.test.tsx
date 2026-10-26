// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useNativeChatVoicePlayback } from './use-native-chat-voice-playback'

afterEach(() => vi.unstubAllGlobals())

it('holds arriving replies during capture without marking their audio as already consumed', () => {
  const speak = vi.fn()
  const cancel = vi.fn()
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [{ lang: 'ko-KR', localService: true }],
    speak,
    cancel,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(public text: string) {}
    }
  )
  const initial: { messages: NativeChatMessage[]; paused: boolean } = { messages: [], paused: true }
  const hook = renderHook(
    ({ messages, paused }) =>
      useNativeChatVoicePlayback(messages, false, true, undefined, paused, 'ko'),
    { initialProps: initial }
  )
  const messages: NativeChatMessage[] = [
    {
      id: 'answer',
      source: 'transcript',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text: '안녕하세요.' }]
    }
  ]
  hook.rerender({ messages, paused: true })
  expect(speak).not.toHaveBeenCalled()
  expect(hook.result.current.pending).toBe(true)
  hook.rerender({ messages, paused: false })
  expect(speak).toHaveBeenCalledTimes(1)
  expect(hook.result.current.caption).toBe('안녕하세요.')
  act(() => hook.result.current.stop())
  hook.rerender({ messages, paused: false })
  expect(speak).toHaveBeenCalledTimes(1)
  expect(cancel).toHaveBeenCalledTimes(1)
  hook.unmount()
})
