import type { ElevenLabsSpeechRequest } from '../../../../shared/speech-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { playElevenLabsStream } from './elevenlabs-stream-playback'

export function playElevenLabsSpeech(
  request: Omit<ElevenLabsSpeechRequest, 'requestId'>,
  onEnd: () => void,
  onError: () => void
): () => void {
  const requestId = createBrowserUuid()
  if (
    typeof AudioContext !== 'undefined' &&
    window.api.speech.streamElevenLabs &&
    window.api.speech.onElevenLabsAudio
  ) {
    return playElevenLabsStream({ ...request, requestId }, onEnd, onError)
  }
  let canceled = false
  let audio: HTMLAudioElement | null = null
  let url: string | null = null
  const cleanup = () => {
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio = null
    }
    if (url) {
      URL.revokeObjectURL(url)
    }
    url = null
  }
  const fail = () => {
    cleanup()
    if (!canceled) {
      canceled = true
      onError()
    }
  }
  void window.api.speech
    .synthesizeElevenLabs({ ...request, requestId })
    .then(async (bytes) => {
      if (canceled) {
        return
      }
      const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' })
      url = URL.createObjectURL(blob)
      audio = new Audio(url)
      audio.onended = () => {
        cleanup()
        if (!canceled) {
          canceled = true
          onEnd()
        }
      }
      audio.onerror = fail
      await audio.play()
    })
    .catch(fail)
  return () => {
    canceled = true
    cleanup()
    void window.api.speech.cancelElevenLabs(requestId).catch(() => undefined)
  }
}
