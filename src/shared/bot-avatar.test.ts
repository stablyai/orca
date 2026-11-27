import { describe, expect, it } from 'vitest'
import {
  avatarPackAvatar,
  isAvatarPackAvatar,
  isSettableBotAvatar,
  parseBotAvatar
} from './bot-avatar'
import { botFallback } from './bots/bot-avatar-fallback'

describe('bot-avatar animated pack support', () => {
  it('round-trips valid mascot:pack/<pack>/<index> identifiers', () => {
    const encoded = avatarPackAvatar('chromahair', 12)
    expect(encoded).toBe('mascot:pack/chromahair/12')
    expect(isAvatarPackAvatar(encoded)).toBe(true)
    expect(isSettableBotAvatar(encoded)).toBe(true)
    expect(parseBotAvatar(encoded)).toEqual({
      kind: 'avatar-pack',
      pack: 'chromahair',
      charIndex: 12
    })
  })

  it('rejects malformed or path-traversal pack identifiers and falls back to initial, never raw text', () => {
    for (const invalid of [
      'mascot:pack/onlypack',
      'mascot:pack/../evil/0',
      'mascot:pack/a/b/0',
      'mascot:pack/pack/-1',
      'mascot:pack/pack:bad/0'
    ]) {
      expect(parseBotAvatar(invalid), invalid).toBeNull()
      expect(isSettableBotAvatar(invalid), invalid).toBe(false)
      expect(botFallback({ name: 'Scout', avatar: invalid }), invalid).toBe('S')
    }
  })
})
