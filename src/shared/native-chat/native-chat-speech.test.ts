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

  it('keeps comparisons and generics, and drops real tags', () => {
    expect(nativeChatTextForSpeech('if x < 5 and y > 3')).toBe('if x < 5 and y > 3')
    expect(nativeChatTextForSpeech('Тип `Promise<void>`.\n\n```ts\nArray<string>\n```')).toBe(
      'Тип Promise<void>.\n\nArray<string>'
    )
    expect(nativeChatTextForSpeech('Жирный <strong>текст</strong>')).toBe('Жирный  текст')
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

  it('speaks a reply that has no Russian or English letters', () => {
    expect(segmentNativeChatSpeech('42')).toEqual([{ text: '42', lang: 'en-US' }])
    expect(segmentNativeChatSpeech('100%')).toEqual([{ text: '100%', lang: 'en-US' }])
    expect(segmentNativeChatSpeech('   ')).toEqual([])
  })

  it('chunks a long reply on a space', () => {
    expect(chunkNativeChatSpeech('один два три четыре', 10)).toEqual(['один два', 'три четыре'])
  })
})
