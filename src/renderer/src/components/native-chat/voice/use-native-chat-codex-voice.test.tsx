// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useNativeChatCodexVoice } from './use-native-chat-codex-voice'
import {
  FakeVoiceAudio,
  FakeVoicePeer,
  FakeVoiceTrack,
  fakeVoiceStream
} from './codex-voice-call.test-fixture'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState({ dictationState: 'idle' })
})

it('ends a voice call when dictation takes the microphone from anywhere, its shortcut included', async () => {
  const track = new FakeVoiceTrack()
  const peer = new FakeVoicePeer()
  let unsubscribed = false
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => fakeVoiceStream(track),
      enumerateDevices: async () => []
    }
  })
  vi.stubGlobal('RTCPeerConnection', function RTCPeerConnection() {
    return peer.asPeer()
  })
  vi.stubGlobal('Audio', function Audio() {
    return new FakeVoiceAudio().asAudio()
  })
  vi.stubGlobal('api', {
    runtime: {
      subscribe: async () => ({
        unsubscribe: () => {
          unsubscribed = true
        }
      })
    }
  })
  const { result } = renderHook(() =>
    useNativeChatCodexVoice({
      sessionId: 'session-1',
      target: { kind: 'local' },
      agent: 'codex',
      visible: true
    })
  )
  await act(async () => {
    result.current?.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(result.current?.call?.phase).toBe('connecting')

  act(() => useAppStore.setState({ dictationState: 'listening' }))
  expect(track.stopped).toBe(true)
  expect(peer.closed).toBe(true)
  expect(unsubscribed).toBe(true)
  expect(result.current?.call).toBeNull()
})
