import { describe, expect, it } from 'vitest'
import {
  chunkNativeChatSpeech,
  nativeChatTextForSpeech,
  normalizeNativeChatSpeechSettings,
  resolveNativeChatSpeechSettings,
  segmentNativeChatSpeech
} from './native-chat-speech'

describe('native chat speech settings', () => {
  it('keeps an absent value on the defaults', () => {
    expect(normalizeNativeChatSpeechSettings(undefined)).toBeUndefined()
    expect(resolveNativeChatSpeechSettings(undefined)).toEqual({
      enabled: true,
      engine: 'web-speech',
      voice: 'ru-RU-SvetlanaNeural',
      rate: 1,
      auto: false
    })
  })

  it('stores only the choices that differ from the defaults', () => {
    expect(
      normalizeNativeChatSpeechSettings({
        enabled: false,
        engine: 'edge',
        voice: 'ru-RU-DmitryNeural',
        rate: 1.24,
        auto: true
      })
    ).toEqual({
      enabled: false,
      engine: 'edge',
      voice: 'ru-RU-DmitryNeural',
      rate: 1.2,
      auto: true
    })
    expect(
      normalizeNativeChatSpeechSettings({
        enabled: true,
        engine: 'web-speech',
        voice: 'ru-RU-SvetlanaNeural',
        rate: 1,
        auto: false
      })
    ).toBeUndefined()
  })

  it('drops a rate outside 0.5–2 and an unknown voice', () => {
    expect(normalizeNativeChatSpeechSettings({ rate: 9, voice: 'en-US-AriaNeural' })).toEqual({
      rate: 2
    })
  })
})

describe('native chat speech text', () => {
  it('drops markdown markers and keeps code words', () => {
    expect(
      nativeChatTextForSpeech(
        '# Заголовок\n\nВызови `useState` и запусти:\n\n```ts\nnpm install\n```\n\n[документация](https://example.com)'
      )
    ).toBe('Заголовок\n\nВызови useState и запусти:\n\nnpm install\n\nдокументация')
  })

  it('splits English words out of a Russian sentence and keeps English phrases together', () => {
    expect(
      segmentNativeChatSpeech('Функция useState возвращает значение из API.').map((segment) => [
        segment.lang,
        segment.text.trim()
      ])
    ).toEqual([
      ['ru-RU', 'Функция'],
      ['en-US', 'useState'],
      ['ru-RU', 'возвращает значение из'],
      ['en-US', 'API.']
    ])
    expect(
      segmentNativeChatSpeech('Сделай git pull request.').map((segment) => segment.text.trim())
    ).toEqual(['Сделай', 'git pull request.'])
  })

  it('chunks a long reply on a space', () => {
    expect(chunkNativeChatSpeech('один два три четыре', 10)).toEqual(['один два', 'три четыре'])
  })
})
