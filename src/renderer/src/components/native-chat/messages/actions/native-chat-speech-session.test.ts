import { describe, expect, it } from 'vitest'
import { EDGE_SPEECH_CANCELLED_MESSAGE } from '../../../../../../shared/native-chat/native-chat-speech'
import {
  isEdgeSpeechCancelled,
  speakWebSpeechSegments,
  type WebSpeechUtterance,
  type WebSpeechVoice
} from './native-chat-speech-session'

function utterance(text: string): WebSpeechUtterance {
  return { text, lang: '', rate: 1, voice: null, onend: null, onerror: null }
}

function bindUtterance(
  utterance: WebSpeechUtterance,
  spoken: { lang: 'ru-RU' | 'en-US'; rate: number; voice: WebSpeechVoice | null; done: () => void }
): void {
  utterance.lang = spoken.lang
  utterance.rate = spoken.rate
  utterance.voice = spoken.voice
  utterance.onend = spoken.done
  utterance.onerror = spoken.done
}

const voices: WebSpeechVoice[] = [
  { lang: 'ru-RU', localService: true },
  { lang: 'en-US', localService: true },
  { lang: 'en-GB', localService: false }
]

describe('edge speech cancellation', () => {
  it('recognises a stop after Electron wraps the main-process error', () => {
    expect(isEdgeSpeechCancelled(new Error(EDGE_SPEECH_CANCELLED_MESSAGE))).toBe(true)
    expect(
      isEdgeSpeechCancelled(
        new Error(
          `Error invoking remote method 'speech:synthesize': Error: ${EDGE_SPEECH_CANCELLED_MESSAGE}`
        )
      )
    ).toBe(true)
    expect(isEdgeSpeechCancelled(new Error('Edge speech connection closed'))).toBe(false)
  })
})

describe('web speech queue', () => {
  it('gives each script its own local voice', async () => {
    const spoken: WebSpeechUtterance[] = []
    await speakWebSpeechSegments({
      text: 'Функция useState.',
      rate: 1.2,
      synth: {
        cancel: () => undefined,
        getVoices: () => voices,
        speak: (value) => {
          spoken.push(value)
          value.onend?.()
        }
      },
      createUtterance: utterance,
      bindUtterance,
      cancelled: () => false
    })
    expect(
      spoken.map((item) => [item.lang, item.text.trim(), item.voice?.lang, item.rate])
    ).toEqual([
      ['ru-RU', 'Функция', 'ru-RU', 1.2],
      ['en-US', 'useState.', 'en-US', 1.2]
    ])
  })

  it('does not speak the rest of a reply after it is cancelled', async () => {
    let spoken = 0
    await speakWebSpeechSegments({
      text: 'Функция useState возвращает значение из API.',
      rate: 1,
      synth: {
        cancel: () => undefined,
        getVoices: () => voices,
        speak: (value) => {
          spoken += 1
          value.onend?.()
        }
      },
      createUtterance: utterance,
      bindUtterance,
      cancelled: () => spoken > 0
    })
    expect(spoken).toBe(1)
  })
})
