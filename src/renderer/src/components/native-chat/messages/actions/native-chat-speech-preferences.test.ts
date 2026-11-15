import { describe, expect, it } from 'vitest'
import type { ResolvedNativeChatSpeech } from '../../../../../../shared/native-chat/native-chat-speech'
import { nativeChatSpeechTurnsOff } from './native-chat-speech-preferences'

const enabled = {
  enabled: true,
  engine: 'web-speech',
  voice: 'ru-RU-SvetlanaNeural',
  rate: 1,
  auto: false
} satisfies ResolvedNativeChatSpeech

describe('native chat speech preferences', () => {
  it('turns speech off only on that transition', () => {
    expect(nativeChatSpeechTurnsOff(enabled, { enabled: false }, false)).toBe(false)
    expect(nativeChatSpeechTurnsOff(enabled, { enabled: false }, true)).toBe(true)
    expect(nativeChatSpeechTurnsOff(enabled, { auto: true }, true)).toBe(false)
    expect(nativeChatSpeechTurnsOff({ ...enabled, enabled: false }, { enabled: false }, true)).toBe(
      false
    )
  })
})
