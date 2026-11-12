import { afterEach, expect, it, vi } from 'vitest'
import { CodexVoiceCall, type CodexVoiceCallDeps } from './codex-voice-call'
import {
  FakeVoiceAudio,
  FakeVoiceHostStream,
  FakeVoicePeer,
  FakeVoiceTrack,
  fakeVoiceStream
} from './codex-voice-call.test-fixture'

afterEach(() => {
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await Promise.resolve()
  }
}

function harness(openMicrophone?: CodexVoiceCallDeps['openMicrophone']) {
  const track = new FakeVoiceTrack()
  const peer = new FakeVoicePeer()
  const host = new FakeVoiceHostStream()
  let peersCreated = 0
  const call = new CodexVoiceCall(
    {
      openMicrophone: openMicrophone ?? (async () => fakeVoiceStream(track)),
      createPeer: () => {
        peersCreated += 1
        return peer.asPeer()
      },
      createAudio: () => new FakeVoiceAudio().asAudio(),
      subscribe: host.subscribe
    },
    () => {}
  )
  return { call, track, peer, host, peersCreated: () => peersCreated }
}

it('releases the microphone, peer and host stream on hang-up and ignores a late answer', async () => {
  const { call, track, peer, host } = harness()
  void call.start()
  await settle()
  host.push({ type: 'answer', sdp: 'v=0 synthetic answer' })
  peer.moveTo('connected')
  expect(call.current.phase).toBe('live')

  call.stop()
  host.push({ type: 'answer', sdp: 'v=0 late answer' })
  expect(track.stopped).toBe(true)
  expect(peer.closed).toBe(true)
  expect(peer.channel.closed).toBe(true)
  expect(host.unsubscribed).toBe(true)
  expect(peer.remoteAnswers).toEqual(['v=0 synthetic answer'])
  expect(call.current).toMatchObject({ phase: 'ended', failure: null })
})

it('applies a mute pressed while the microphone opens before any audio is sent', async () => {
  const track = new FakeVoiceTrack()
  let open: (stream: MediaStream) => void = () => {}
  const { call } = harness(() => new Promise((resolve) => (open = resolve)))
  void call.start()
  call.setMuted(true)
  open(fakeVoiceStream(track))
  await settle()
  expect(track.enabled).toBe(false)
})

it('closes a microphone that opens after the call was cancelled, without offering', async () => {
  const track = new FakeVoiceTrack()
  let open: (stream: MediaStream) => void = () => {}
  const { call, host, peersCreated } = harness(() => new Promise((resolve) => (open = resolve)))
  void call.start()
  call.stop()
  open(fakeVoiceStream(track))
  await settle()
  expect(track.stopped).toBe(true)
  expect(peersCreated()).toBe(0)
  expect(host.offerSdp).toBeNull()
})

it('reports a denied microphone and opens nothing else', async () => {
  const { call, peersCreated } = harness(async () => {
    throw new DOMException('denied', 'NotAllowedError')
  })
  await call.start()
  expect(call.current.failure).toEqual({ kind: 'microphone-denied' })
  expect(peersCreated()).toBe(0)
})

it('stops capturing when the call never connects', async () => {
  vi.useFakeTimers()
  const { call, track, peer, host } = harness()
  void call.start()
  await settle()
  vi.runOnlyPendingTimers()
  expect(call.current.failure).toEqual({ kind: 'connect-timeout' })
  expect(track.stopped).toBe(true)
  expect(peer.closed).toBe(true)
  expect(host.unsubscribed).toBe(true)
})

it('ends the call when the microphone ends from outside', async () => {
  const { call, track, peer } = harness()
  void call.start()
  await settle()
  peer.moveTo('connected')
  track.endFromOutside()
  expect(call.current.failure).toEqual({ kind: 'microphone-lost' })
  expect(track.listening).toBe(false)
  expect(peer.closed).toBe(true)
})

it('releases local resources even when the host stream fails to unsubscribe', async () => {
  const track = new FakeVoiceTrack()
  const peer = new FakeVoicePeer()
  const call = new CodexVoiceCall(
    {
      openMicrophone: async () => fakeVoiceStream(track),
      createPeer: () => peer.asPeer(),
      createAudio: () => new FakeVoiceAudio().asAudio(),
      subscribe: async () => ({
        unsubscribe: () => {
          throw new Error('runtime transport closed')
        }
      })
    },
    () => {}
  )
  void call.start()
  await settle()
  expect(() => call.stop()).not.toThrow()
  expect(track.stopped).toBe(true)
  expect(peer.closed).toBe(true)
})
