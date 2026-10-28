import { describe, expect, it } from 'vitest'
import {
  isInNativeChatUpgradeTipAudience,
  nativeChatUpgradeTipVariant
} from './native-chat-upgrade-tip-audience'

describe('nativeChatUpgradeTipVariant', () => {
  it.each([
    ['eligible', 'chat-ui-on', 'standard'],
    ['eligible', 'chat-ui-on-terminal-default', 'keep-terminal'],
    ['excluded', 'chat-ui-on-terminal-default', 'none'],
    ['excluded', 'chat-ui-off', 'none'],
    ['excluded', 'new-profile', 'none']
  ] as const)('gives %s/%s the %s tip', (membership, basis, variant) => {
    expect(nativeChatUpgradeTipVariant({ version: 1, membership, basis })).toBe(variant)
  })

  it('shows no tip without a readable record', () => {
    expect(nativeChatUpgradeTipVariant(null)).toBe('none')
  })
})

describe('isInNativeChatUpgradeTipAudience', () => {
  it.each([
    [null, null],
    ['none', false],
    ['standard', true],
    ['keep-terminal', true]
  ] as const)('reads variant %s as %s', (variant, inAudience) => {
    expect(isInNativeChatUpgradeTipAudience(variant)).toBe(inAudience)
  })
})
