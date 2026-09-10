import { describe, expect, it } from 'vitest'
import { getNativeChatAgentProfile } from './native-chat-agent-profiles'

describe('native chat agent picker profiles', () => {
  // The composer types the same `/` for every agent; skillPrefix is only the
  // form a picked skill is written as.
  it('keeps Codex skills invocable as dollar tokens', () => {
    expect(getNativeChatAgentProfile('codex')).toMatchObject({
      skillPrefix: '$',
      skillSourceOwner: 'codex'
    })
  })

  it('writes Claude-family and Grok skills as slash tokens', () => {
    expect(getNativeChatAgentProfile('claude')).toMatchObject({
      skillPrefix: '/',
      skillSourceOwner: 'claude'
    })
    expect(getNativeChatAgentProfile('openclaude')).toMatchObject({ skillSourceOwner: 'claude' })
    expect(getNativeChatAgentProfile('grok')).toMatchObject({
      skillPrefix: '/',
      skillSourceOwner: 'grok'
    })
  })

  it('does not grant custom or unverified agents a skill grammar', () => {
    expect(getNativeChatAgentProfile('custom-agent')).toBeNull()
  })
})
