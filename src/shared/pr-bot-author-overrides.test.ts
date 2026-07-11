import { describe, expect, it } from 'vitest'
import {
  MAX_PR_BOT_AUTHOR_OVERRIDES,
  MAX_PR_COMMENT_AUTHOR_LOGIN_LENGTH,
  normalizePRBotAuthorOverrides
} from './pr-bot-author-overrides'

describe('PR bot author override normalization', () => {
  it('bounds inspected entries before normalizing untrusted arrays', () => {
    let reads = 0
    const values = Array.from(
      { length: MAX_PR_BOT_AUTHOR_OVERRIDES + 20 },
      (_, index) => `bot-${index}`
    )
    const tracked = new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          reads += 1
        }
        return Reflect.get(target, property, receiver)
      }
    })

    expect(normalizePRBotAuthorOverrides(tracked)).toHaveLength(MAX_PR_BOT_AUTHOR_OVERRIDES)
    expect(reads).toBe(MAX_PR_BOT_AUTHOR_OVERRIDES)
  })

  it('drops overlong author logins instead of retaining oversized settings data', () => {
    const overlong = 'x'.repeat(MAX_PR_COMMENT_AUTHOR_LOGIN_LENGTH + 1)

    expect(normalizePRBotAuthorOverrides(['regular-bot', overlong])).toEqual(['regular-bot'])
  })
})
