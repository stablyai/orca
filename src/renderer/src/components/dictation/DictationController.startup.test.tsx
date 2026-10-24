// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings, getDefaultVoiceSettings } from '../../../../shared/constants'
import { DictationController } from './DictationController'
import { DICTATION_CONTROL_EVENT } from './dictation-control-events'

const audio = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  flushBufferedAudio: vi.fn(async () => {}),
  discardBufferedAudio: vi.fn(),
  getCapturedChunkCount: () => 1
}))
vi.mock('@/hooks/use-audio-capture', () => ({ useAudioCapture: () => audio }))
vi.mock('./DictationIndicator', () => ({ DictationIndicator: () => null }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['keyup', 'Stop', 'blur'] as const)(
  'owns startup synchronously and honors %s before microphone acquisition settles',
  async (ending) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    const settings = getDefaultSettings('/tmp')
    settings.voice = {
      ...getDefaultVoiceSettings(),
      enabled: true,
      sttModel: 'fixture',
      dictationMode: 'hold'
    }
    useAppStore.setState({ settings, dictationState: 'idle', keybindings: {} })
    let finishCapture: (() => void) | undefined
    audio.start.mockReset().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCapture = resolve
        })
    )
    audio.stop.mockClear()
    audio.flushBufferedAudio.mockClear()
    let stopped: ((event: { sessionId: string }) => void) | undefined
    const speech = {
      onPartialTranscript: () => () => {},
      onFinalTranscript: () => () => {},
      onError: () => () => {},
      onStopped: (callback: typeof stopped) => {
        stopped = callback
        return () => {
          stopped = undefined
        }
      },
      startDictation: vi.fn(async () => {}),
      stopDictation: vi.fn(async (sessionId: string) => {
        stopped?.({ sessionId })
      })
    }
    vi.stubGlobal('api', { speech })
    const view = render(
      <>
        <textarea aria-label="Target" />
        <DictationController />
      </>
    )
    view.getByRole('textbox').focus()
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'e',
          code: 'KeyE',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    expect(useAppStore.getState().dictationState).toBe('starting')
    expect(audio.start).toHaveBeenCalledOnce()
    act(() => {
      if (ending === 'keyup') {
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', code: 'KeyE' }))
      }
      if (ending === 'Stop') {
        document.dispatchEvent(new CustomEvent(DICTATION_CONTROL_EVENT, { detail: 'stop' }))
      }
      if (ending === 'blur') {
        window.dispatchEvent(new Event('blur'))
      }
    })
    expect(useAppStore.getState().dictationState).toBe('stopping')
    await act(async () => finishCapture?.())
    expect(speech.startDictation).toHaveBeenCalledOnce()
    expect(audio.flushBufferedAudio).toHaveBeenCalledOnce()
    expect(speech.stopDictation).toHaveBeenCalledOnce()
    expect(useAppStore.getState().dictationState).toBe('idle')
    expect(audio.stop).toHaveBeenCalledWith({ preserveBufferedAudio: true })
  }
)
