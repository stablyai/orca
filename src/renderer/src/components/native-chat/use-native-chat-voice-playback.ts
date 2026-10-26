import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { localVoiceForLanguage, StsVoicePlayback } from '../../../../shared/sts-voice-playback'
import { playElevenLabsSpeech } from '../dictation/elevenlabs-playback'
import { useLocalSpeechVoices } from '../dictation/use-local-speech-voices'

export function useNativeChatVoicePlayback(
  messages: readonly NativeChatMessage[],
  working: boolean,
  enabled: boolean,
  settings?: VoiceSettings,
  paused = false,
  language = 'en'
) {
  const { voices } = useLocalSpeechVoices()
  const voice = localVoiceForLanguage(voices, language, settings?.localVoiceUri)
  const [speaking, setSpeaking] = useState(false)
  const [caption, setCaption] = useState('')
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  const playback = useRef(new StsVoicePlayback())
  const current = useRef<{ cancel: () => void } | null>(null)
  const latest = useRef(messages)
  latest.current = messages
  const cloud = settings?.ttsProvider === 'elevenlabs'
  const voiceId = settings?.elevenLabsVoiceId ?? ''
  const modelId = settings?.elevenLabsTtsModel ?? 'eleven_flash_v2_5'
  const available = cloud
    ? Boolean(
        settings?.elevenLabsApiKeyConfigured && voiceId && window.api.speech.synthesizeElevenLabs
      )
    : Boolean(voice && typeof SpeechSynthesisUtterance !== 'undefined')

  const stop = useCallback(() => {
    const active = current.current
    current.current = null
    active?.cancel()
    playback.current.reset(latest.current)
    setSpeaking(false)
    setCaption('')
  }, [])

  const complete = useCallback((run: { cancel: () => void }, failed: boolean) => {
    if (current.current !== run) {
      return
    }
    current.current = null
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Audio completion and synchronous playback failure must release the microphone gate.
    setSpeaking(false)
    if (failed) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Report an external playback failure, including a synchronous audio API exception.
      setError(true)
    } else {
      setRevision((value) => value + 1)
    }
  }, [])

  useEffect(() => {
    playback.current.reset(latest.current)
    setError(false)
    return stop
  }, [enabled, cloud, voiceId, modelId, available, voice?.voiceURI, language, stop])

  useEffect(() => {
    if (!enabled || paused || !available || error || current.current) {
      return
    }
    const next = playback.current.next(messages, working)
    if (!next) {
      return
    }
    const run = { cancel: () => {} }
    current.current = run
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Starting external audio must disable microphone capture immediately.
    setSpeaking(true)
    setCaption(next)
    try {
      if (cloud) {
        run.cancel = playElevenLabsSpeech(
          { text: next, voiceId, modelId },
          () => complete(run, false),
          () => complete(run, true)
        )
      } else if (voice) {
        const utterance = new SpeechSynthesisUtterance(next)
        utterance.voice = voice
        utterance.lang = voice.lang
        utterance.rate = 0.95
        utterance.onend = () => complete(run, false)
        utterance.onerror = () => complete(run, true)
        run.cancel = () => {
          utterance.onend = null
          utterance.onerror = null
          window.speechSynthesis.cancel()
        }
        window.speechSynthesis.speak(utterance)
      }
    } catch {
      run.cancel()
      complete(run, true)
    }
  }, [
    enabled,
    paused,
    available,
    cloud,
    error,
    messages,
    modelId,
    revision,
    voice,
    voiceId,
    working,
    complete
  ])

  const pending = enabled && available && !error && playback.current.hasPending(messages, working)
  const restart = () => {
    stop()
    setError(false)
  }
  return { speaking, pending, caption, available, error, stop, restart }
}
