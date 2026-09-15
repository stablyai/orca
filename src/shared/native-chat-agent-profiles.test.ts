import { describe, expect, it } from 'vitest'
import {
  getHostClaimedNativeChatCommands,
  getNativeChatAgentProfile,
  getVerifiedNativeChatCommands
} from './native-chat-agent-profiles'

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
    expect(getNativeChatAgentProfile('openclaw')).toMatchObject({
      skillPrefix: '/',
      skillSourceOwner: 'openclaw'
    })
    expect(getNativeChatAgentProfile('zeroclaw')).toMatchObject({
      skillPrefix: '/',
      skillSourceOwner: 'zeroclaw'
    })
  })

  it('does not grant custom or unverified agents a skill grammar', () => {
    expect(getNativeChatAgentProfile('custom-agent')).toBeNull()
  })
})

describe('host-claimed native chat commands', () => {
  function names(agent: string): string[] {
    return getHostClaimedNativeChatCommands(agent).map((command) => command.name)
  }

  // Claude's harness expands a slash command out of the message body, so claiming
  // its catalog only answered "/init is not available" for commands that do run.
  it('claims nothing from the Claude-family catalog', () => {
    expect(names('claude')).toEqual([])
    expect(names('openclaude')).toEqual([])
  })

  it('keeps the Codex catalog claimed except the model-driven /goal', () => {
    expect(names('codex')).toContain('permissions')
    expect(names('codex')).toContain('vim')
    expect(names('codex')).not.toContain('goal')
    expect(getVerifiedNativeChatCommands('codex').map((command) => command.name)).toContain('goal')
  })

  it('claims the whole catalog for agents with no pass-through policy', () => {
    expect(names('custom-agent')).toEqual(['clear', 'help'])
    expect(names('grok')).toEqual([])
  })
})
