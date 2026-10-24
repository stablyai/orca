// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechApi } from '../../../../preload/api/speech-api'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { useAppStore, type AppState } from '@/store'
import { DictationController } from './DictationController'
import { dispatchDictationControl, type DictationControlAction } from './dictation-control-events'
import { handleVoiceDictationToggle } from '../settings/voice-dictation-toggle'

type CaptureState = Pick<
  AppState,
  | 'settings'
  | 'keybindings'
  | 'dictationState'
  | 'partialTranscript'
  | 'setDictationState'
  | 'setPartialTranscript'
  | 'recordFeatureInteraction'
>

const { insertText } = vi.hoisted(() => ({ insertText: vi.fn() }))

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create<CaptureState>((set) => ({
      settings: null,
      keybindings: {},
      dictationState: 'idle',
      partialTranscript: '',
      setDictationState: (dictationState) => set({ dictationState }),
      setPartialTranscript: (partialTranscript) => set({ partialTranscript }),
      recordFeatureInteraction: vi.fn()
    }))
  }
})
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), message: vi.fn() })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: () => ({ keys: [], doubleTap: false })
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null
}))
vi.mock('./dictation-insertion-target', () => ({
  captureInsertionTarget: () => ({
    kind: 'text',
    element: document.createElement('textarea')
  }),
  insertText
}))

class CaptureTrack extends EventTarget {
  stop = vi.fn()
}

class CaptureContext {
  state = 'running'
  sampleRate = 48_000
  destination = {}
  source = { connect: vi.fn(), disconnect: vi.fn() }
  processor: {
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    onaudioprocess?: (event: { inputBuffer: { getChannelData: () => Float32Array } }) => void
  } = {
    connect: vi.fn(),
    disconnect: vi.fn()
  }
  resume = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  createMediaStreamSource = vi.fn(() => this.source)
  createScriptProcessor = vi.fn(() => this.processor)
}

function deferred() {
  let resolve = (): void => {
    throw new Error('Deferred promise not initialized')
  }
  const promise = new Promise<void>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

let tracks: CaptureTrack[]
let contexts: CaptureContext[]
let onFinal: Parameters<SpeechApi['onFinalTranscript']>[0] | undefined
let onStopped: Parameters<SpeechApi['onStopped']>[0] | undefined
let onKeyDown: (() => void) | undefined
let calls: string[]
const startSpeech = vi.fn<SpeechApi['startDictation']>()
const stopSpeech = vi.fn<SpeechApi['stopDictation']>()
const feedAudio = vi.fn<SpeechApi['feedAudio']>()
const getUserMedia = vi.fn(async () => {
  const track = new CaptureTrack()
  tracks.push(track)
  return { getTracks: () => [track], getAudioTracks: () => [track] }
})

function updateVoice(updates: Partial<VoiceSettings>): void {
  useAppStore.setState((state) => ({
    settings: createGlobalSettingsFixture({
      ...state.settings,
      voice: {
        ...getDefaultVoiceSettings(),
        ...state.settings?.voice,
        ...updates
      }
    })
  }))
}

async function disable(): Promise<void> {
  await act(async () => {
    await handleVoiceDictationToggle({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateVoiceSettings: updateVoice,
      requestMicrophonePermission: vi.fn(async () => {
        throw new Error('Disabling must not request microphone permission')
      })
    })
  })
}

async function control(action: DictationControlAction): Promise<void> {
  await act(async () => dispatchDictationControl(action))
}

function processAudio(sample: number): void {
  act(() => {
    contexts.at(-1)?.processor.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => new Float32Array(4096).fill(sample)
      }
    })
  })
}

function expectReleased(index = 0): void {
  expect(tracks[index].stop).toHaveBeenCalled()
  expect(contexts[index].close).toHaveBeenCalledTimes(1)
}

beforeEach(() => {
  tracks = []
  contexts = []
  calls = []
  onFinal = undefined
  onStopped = undefined
  onKeyDown = undefined
  insertText.mockClear()
  getUserMedia.mockClear()
  startSpeech.mockReset().mockResolvedValue(undefined)
  feedAudio.mockReset().mockImplementation(async (_samples, _rate, sessionId) => {
    calls.push(`feed:${sessionId}`)
  })
  stopSpeech.mockReset().mockImplementation(async (sessionId) => {
    if (!sessionId) {
      throw new Error('Missing session identity')
    }
    calls.push(`stop:${sessionId}`)
    onFinal?.({ sessionId, text: `final ${sessionId}` })
    onStopped?.({ sessionId })
  })
  vi.stubGlobal(
    'AudioContext',
    class extends CaptureContext {
      constructor() {
        super()
        contexts.push(this)
      }
    }
  )
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  })
  const speech = {
    startDictation: startSpeech,
    stopDictation: stopSpeech,
    feedAudio,
    onFinalTranscript: (listener) => {
      onFinal = listener
      return () => {
        onFinal = undefined
      }
    },
    onStopped: (listener) => {
      onStopped = listener
      return () => {
        onStopped = undefined
      }
    },
    onPartialTranscript: () => () => undefined,
    onError: () => () => undefined
  } satisfies Pick<
    SpeechApi,
    | 'startDictation'
    | 'stopDictation'
    | 'feedAudio'
    | 'onFinalTranscript'
    | 'onStopped'
    | 'onPartialTranscript'
    | 'onError'
  >
  Object.assign(window, {
    api: {
      speech,
      ui: {
        onDictationKeyDown: (listener: () => void) => {
          onKeyDown = listener
          return () => {
            onKeyDown = undefined
          }
        }
      }
    }
  })
  useAppStore.setState({ dictationState: 'idle', partialTranscript: '' })
  updateVoice({
    enabled: true,
    sttModel: 'offline-model',
    dictationMode: 'toggle'
  })
  render(<DictationController />)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DictationController capture lifetime', () => {
  it('releases listening capture when disabled and preserves the final transcript', async () => {
    await control('start')
    processAudio(0.1)
    await disable()
    expectReleased()
    expect(contexts[0].source.disconnect).toHaveBeenCalledTimes(1)
    expect(contexts[0].processor.disconnect).toHaveBeenCalledTimes(1)
    processAudio(0.2)
    expect(feedAudio).toHaveBeenCalledTimes(1)
    expect(stopSpeech).toHaveBeenCalledExactlyOnceWith('1')
    expect(insertText).toHaveBeenCalledExactlyOnceWith('final 1', expect.anything())
    expect(useAppStore.getState().dictationState).toBe('idle')
  })

  it('keeps the stopped session open for delayed final delivery after disable', async () => {
    stopSpeech.mockResolvedValueOnce(undefined)
    await control('start')
    processAudio(0.1)
    await disable()
    expectReleased()
    expect(useAppStore.getState().dictationState).toBe('stopping')
    expect(insertText).not.toHaveBeenCalled()
    await act(async () => {
      onFinal?.({ sessionId: 'old-session', text: 'stale words' })
      onFinal?.({ sessionId: '1', text: 'delayed words' })
      onStopped?.({ sessionId: '1' })
    })
    expect(insertText).toHaveBeenCalledExactlyOnceWith('delayed words', expect.anything())
    expect(useAppStore.getState().dictationState).toBe('idle')
  })

  it.each(['disable', 'stop'] as const)(
    'preserves startup audio order and session identity on %s',
    async (action) => {
      for (let cycle = 0; cycle < 2; cycle++) {
        const ready = deferred()
        startSpeech.mockImplementationOnce(() => ready.promise)
        await act(async () => updateVoice({ enabled: true }))
        await control('start')
        processAudio(0.1)
        processAudio(0.2)
        await (action === 'disable'
          ? disable()
          : act(async () =>
              fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
            ))
        expectReleased(cycle)
        expect(useAppStore.getState().dictationState).toBe('stopping')
        processAudio(0.3)
        await act(async () => ready.resolve())
        expect(useAppStore.getState().dictationState).toBe('idle')
        expect(feedAudio).toHaveBeenCalledTimes((cycle + 1) * 2)
        const sessionId = String(cycle + 1)
        expect(feedAudio.mock.calls[cycle * 2][0][0]).toBeCloseTo(0.1)
        expect(feedAudio.mock.calls[cycle * 2 + 1][0][0]).toBeCloseTo(0.2)
        expect(calls.slice(cycle * 3)).toEqual([
          `feed:${sessionId}`,
          `feed:${sessionId}`,
          `stop:${sessionId}`
        ])
        expect(insertText).toHaveBeenCalledTimes(cycle + 1)
        expect(insertText).toHaveBeenLastCalledWith(`final ${sessionId}`, expect.anything())
      }
    }
  )

  it('stops a microphone returned after disable without connecting an audio graph', async () => {
    const permission = deferred()
    const openStream = getUserMedia.getMockImplementation()
    if (!openStream) {
      throw new Error('Missing media fixture')
    }
    getUserMedia.mockImplementationOnce(async () => {
      await permission.promise
      return openStream()
    })
    await control('start')
    await disable()
    expect(useAppStore.getState().dictationState).toBe('stopping')
    await act(async () => permission.resolve())
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(contexts).toHaveLength(0)
    expect(feedAudio).not.toHaveBeenCalled()
    expect(stopSpeech).toHaveBeenCalledExactlyOnceWith('1')
    expect(useAppStore.getState().dictationState).toBe('idle')
  })

  it('releases a suspended context while resume is pending and never connects it later', async () => {
    const resumed = deferred()
    vi.stubGlobal(
      'AudioContext',
      class extends CaptureContext {
        constructor() {
          super()
          this.state = 'suspended'
          this.resume.mockImplementation(() => resumed.promise)
          contexts.push(this)
        }
      }
    )
    await control('start')
    await disable()
    expectReleased()
    await act(async () => resumed.resolve())
    expectReleased()
    expect(contexts[0].createMediaStreamSource).not.toHaveBeenCalled()
    expect(contexts[0].createScriptProcessor).not.toHaveBeenCalled()
    expect(feedAudio).not.toHaveBeenCalled()
    expect(useAppStore.getState().dictationState).toBe('idle')
  })

  it.each(['stop', 'toggle', 'keyboard'] as const)(
    'allows %s to stop after the selected model is removed',
    async (action) => {
      await control('start')
      await act(async () => updateVoice({ sttModel: '' }))
      await (action === 'keyboard' ? act(async () => onKeyDown?.()) : control(action))
      expectReleased()
      expect(stopSpeech).toHaveBeenCalledExactlyOnceWith('1')
      expect(useAppStore.getState().dictationState).toBe('idle')
    }
  )

  it('rejects new starts while disabled or without a selected model', async () => {
    for (const voice of [{ enabled: false }, { enabled: true, sttModel: '' }]) {
      await act(async () => updateVoice(voice))
      await control('start')
      await control('toggle')
      await act(async () => onKeyDown?.())
    }
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(startSpeech).not.toHaveBeenCalled()
    expect(useAppStore.getState().dictationState).toBe('idle')
  })
})
