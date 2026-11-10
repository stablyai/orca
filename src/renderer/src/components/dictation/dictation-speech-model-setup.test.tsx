// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings, getDefaultVoiceSettings } from '../../../../shared/constants'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import { DictationController } from './DictationController'
import { resetSpeechModelUpdateCheckForTests } from './speech-model-update-check'

const startCapture = vi.fn(async () => ({}))

vi.mock('@/hooks/use-audio-capture', () => ({
  useAudioCapture: () => ({
    start: startCapture,
    stop: vi.fn(),
    finish: vi.fn(async () => {}),
    flushBufferedAudio: vi.fn(async () => {}),
    discardBufferedAudio: vi.fn(),
    getCapturedChunkCount: () => 0,
    getLastSpeechAt: () => 0
  })
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const parakeet: SpeechModelManifest = {
  id: 'parakeet',
  label: 'Parakeet',
  type: 'transducer',
  provider: 'local',
  language: 'en',
  languages: ['en'],
  sampleRate: 16000,
  streaming: false,
  sizeBytes: 740_000_000
}

let root: Root
let container: HTMLDivElement
let pressShortcut: () => void
let modelStates: SpeechModelState[]
const getModelStates = vi.fn(async () => modelStates)
const startDictation = vi.fn(async () => {})

beforeEach(() => {
  resetSpeechModelUpdateCheckForTests()
  startCapture.mockClear()
  getModelStates.mockClear()
  startDictation.mockClear()
  const unsubscribe = () => () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onDictationKeyDown: (callback: () => void) => {
          pressShortcut = callback
          return () => {}
        }
      },
      speech: {
        getCatalog: async () => [parakeet],
        getModelStates,
        startDictation,
        stopDictation: async () => {},
        cancelDictation: async () => {},
        onDownloadProgress: unsubscribe,
        onPartialTranscript: unsubscribe,
        onFinalTranscript: unsubscribe,
        onSpeechPending: unsubscribe,
        onStopped: unsubscribe,
        onError: unsubscribe
      }
    }
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      voice: { ...getDefaultVoiceSettings(), enabled: true, sttModel: 'parakeet' }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

async function mountAndPress(): Promise<void> {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <DictationController />
      </TooltipProvider>
    )
  })
  expect(getModelStates).not.toHaveBeenCalled()
  await act(async () => pressShortcut())
}

describe('dictation shortcut and the speech model update', () => {
  it('offers the download in the pill instead of opening the mic', async () => {
    modelStates = [{ id: 'parakeet', status: 'not-downloaded', needsUpdate: true }]
    await mountAndPress()

    expect(document.querySelector('[data-testid="dictation-setup-pill"]')).not.toBeNull()
    expect(startCapture).not.toHaveBeenCalled()
    expect(startDictation).not.toHaveBeenCalled()
  })

  it('starts dictating when the selected model is up to date', async () => {
    modelStates = [{ id: 'parakeet', status: 'ready' }]
    await mountAndPress()

    expect(document.querySelector('[data-testid="dictation-setup-pill"]')).toBeNull()
    expect(startCapture).toHaveBeenCalledOnce()
    expect(startDictation).toHaveBeenCalledWith('parakeet', {}, expect.any(String))
  })
})
