import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createVoiceActivityGate,
  type VoiceGateEngineCallbacks
} from './voice-control-vad-gate'

type FakeTrack = { label: string }

function setup({ initiallyMuted = false }: { initiallyMuted?: boolean } = {}) {
  const track: FakeTrack = { label: 'mic' }
  const replaceTrack = vi.fn<(next: FakeTrack | null) => Promise<void>>().mockResolvedValue(undefined)
  const engine = {
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    pause: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  }
  let callbacks: VoiceGateEngineCallbacks | null = null
  const createEngine = vi.fn((next: VoiceGateEngineCallbacks) => {
    callbacks = next
    return Promise.resolve(engine)
  })
  const ready = createVoiceActivityGate<FakeTrack>({
    sender: { replaceTrack },
    track,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the injected createEngine never reads the stream; only the production vad-web factory (not exercised here) passes it to MicVAD.
    stream: {} as MediaStream,
    isMuted: () => initiallyMuted,
    createEngine
  })
  const engineCallbacks = (): VoiceGateEngineCallbacks => {
    if (!callbacks) {
      throw new Error('engine was not created')
    }
    return callbacks
  }
  return { track, replaceTrack, engine, createEngine, ready, engineCallbacks }
}

describe('createVoiceActivityGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts closed and physically detaches the mic track', async () => {
    const { ready, replaceTrack } = setup()
    const gate = await ready
    expect(gate.open).toBe(false)
    expect(replaceTrack).toHaveBeenCalledTimes(1)
    expect(replaceTrack).toHaveBeenLastCalledWith(null)
  })

  it('opens on speech start', async () => {
    const { ready, replaceTrack, track, engineCallbacks } = setup()
    const gate = await ready
    engineCallbacks().onSpeechStart()
    expect(gate.open).toBe(true)
    expect(replaceTrack).toHaveBeenLastCalledWith(track)
  })

  it('closes on a server commit before the fallback timer', async () => {
    const { ready, replaceTrack, engineCallbacks } = setup()
    const gate = await ready
    engineCallbacks().onSpeechStart()
    engineCallbacks().onSpeechEnd()
    gate.notifyServerCommit()
    expect(gate.open).toBe(false)
    expect(replaceTrack).toHaveBeenLastCalledWith(null)
    vi.advanceTimersByTime(10_000)
    expect(replaceTrack).toHaveBeenCalledTimes(3)
  })

  it('closes on the fallback timer when no commit arrives', async () => {
    const { ready, replaceTrack, engineCallbacks } = setup()
    const gate = await ready
    engineCallbacks().onSpeechStart()
    engineCallbacks().onSpeechEnd()
    expect(gate.open).toBe(true)
    vi.advanceTimersByTime(2_499)
    expect(gate.open).toBe(true)
    vi.advanceTimersByTime(1)
    expect(gate.open).toBe(false)
    expect(replaceTrack).toHaveBeenLastCalledWith(null)
  })

  it('stays open when speech resumes before the earlier commit lands', async () => {
    const { ready, engineCallbacks } = setup()
    const gate = await ready
    engineCallbacks().onSpeechStart()
    engineCallbacks().onSpeechEnd()
    engineCallbacks().onSpeechStart()
    gate.notifyServerCommit()
    expect(gate.open).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(gate.open).toBe(true)
  })

  it('closes immediately on a VAD misfire', async () => {
    const { ready, replaceTrack, engineCallbacks } = setup()
    const gate = await ready
    engineCallbacks().onSpeechStart()
    expect(gate.open).toBe(true)
    engineCallbacks().onVADMisfire()
    expect(gate.open).toBe(false)
    expect(replaceTrack).toHaveBeenLastCalledWith(null)
  })

  it('keeps the gate closed for speech detected while muted', async () => {
    const { ready, replaceTrack, engineCallbacks } = setup({ initiallyMuted: true })
    const gate = await ready
    engineCallbacks().onSpeechStart()
    expect(gate.open).toBe(false)
    expect(replaceTrack).toHaveBeenCalledTimes(1)
    expect(replaceTrack).toHaveBeenLastCalledWith(null)
  })

  it('mute mid-speech closes the gate and pauses the engine', async () => {
    const { ready, engine, engineCallbacks } = setup()
    const gate = await ready
    engineCallbacks().onSpeechStart()
    expect(gate.open).toBe(true)
    gate.setMuted(true)
    expect(gate.open).toBe(false)
    expect(engine.pause).toHaveBeenCalledTimes(1)
  })

  it('unmute resumes the engine but the gate stays closed until speech', async () => {
    const { ready, engine, engineCallbacks, replaceTrack, track } = setup()
    const gate = await ready
    gate.setMuted(true)
    gate.setMuted(false)
    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(gate.open).toBe(false)
    engineCallbacks().onSpeechStart()
    expect(gate.open).toBe(true)
    expect(replaceTrack).toHaveBeenLastCalledWith(track)
  })

  it('dispose disarms the fallback timer and destroys the engine', async () => {
    const { ready, replaceTrack, engine, engineCallbacks } = setup()
    const gate = await ready
    engineCallbacks().onSpeechStart()
    engineCallbacks().onSpeechEnd()
    gate.dispose()
    expect(engine.destroy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    // Only the initial detach and the speech-start attach; the armed close never fired.
    expect(replaceTrack).toHaveBeenCalledTimes(2)
    expect(() => gate.dispose()).not.toThrow()
  })
})
