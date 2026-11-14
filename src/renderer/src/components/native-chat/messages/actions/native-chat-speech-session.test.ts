import { describe, expect, it } from 'vitest'
import {
  speakWebSpeechSegments,
  type WebSpeechUtterance,
  type WebSpeechVoice
} from './native-chat-speech-session'

function utterance(text: string): WebSpeechUtterance {
  return { text, lang: '', rate: 1, voice: null, onend: null, onerror: null }
}

const voices: WebSpeechVoice[] = [
  { lang: 'ru-RU', localService: true },
  { lang: 'en-US', localService: true },
  { lang: 'en-GB', localService: false }
]

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
      cancelled: () => spoken > 0
    })
    expect(spoken).toBe(1)
  })
})
