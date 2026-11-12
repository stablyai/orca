// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useNativeChatCodexVoice } from './use-native-chat-codex-voice'
import { getDefaultSettings, getDefaultVoiceSettings } from '../../../../../shared/constants'
import {
  FakeVoiceAudio,
  FakeVoicePeer,
  FakeVoiceTrack,
  fakeVoiceStream
} from './codex-voice-call.test-fixture'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState({ dictationState: 'idle', settings: null })
})

function stubMedia(track: FakeVoiceTrack, peer: FakeVoicePeer): void {
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
}

it('ends a voice call when dictation takes the microphone from anywhere, its shortcut included', async () => {
  const track = new FakeVoiceTrack()
  const peer = new FakeVoicePeer()
  let unsubscribed = false
  stubMedia(track, peer)
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

it("starts Voice mode with the voice chosen in Settings, and Codex's own default without one", async () => {
  const subscribed: { method: string; params: unknown }[] = []
  stubMedia(new FakeVoiceTrack(), new FakeVoicePeer())
  vi.stubGlobal('api', {
    runtime: {
      call: async () => ({ ok: true, result: { voices: null } }),
      subscribe: async (request: { method: string; params: unknown }) => {
        subscribed.push(request)
        return { unsubscribe: () => {} }
      }
    }
  })
  const startWith = async (codexVoice: string | undefined) => {
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/fixture'),
        voice: { ...getDefaultVoiceSettings(), ...(codexVoice ? { codexVoice } : {}) }
      }
    })
    const { result, unmount } = renderHook(() =>
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
    unmount()
    return subscribed.at(-1)
  }

  expect(await startWith('juniper')).toMatchObject({
    method: 'agentSession.voiceConversation',
    params: { sessionId: 'session-1', voice: 'juniper' }
  })
  expect((await startWith(undefined))?.params).not.toHaveProperty('voice')
})
