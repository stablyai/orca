import { useCallback, useEffect, useState } from 'react'

export function useLocalSpeechVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const refresh = useCallback(() => {
    setVoices(window.speechSynthesis?.getVoices().filter((voice) => voice.localService) ?? [])
  }, [])
  useEffect(() => {
    const synth = window.speechSynthesis
    refresh()
    synth?.addEventListener('voiceschanged', refresh)
    return () => synth?.removeEventListener('voiceschanged', refresh)
  }, [refresh])
  return { voices, refresh }
}
