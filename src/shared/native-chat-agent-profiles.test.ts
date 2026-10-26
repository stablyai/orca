import { describe, expect, it } from 'vitest'
import {
  getAgentAnsweredNativeChatCommands,
  getHostClaimedNativeChatCommands,
  getNativeChatAgentProfile,
  getNativeChatCommandReply,
  getVerifiedNativeChatCommands
} from './native-chat-agent-profiles'

describe('native chat agent picker profiles', () => {
  // Composer trigger stays /; skillPrefix changes only picked-skill insertion.
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

  // OpenCode 2.x reads the same skill folders as 1.x.
  it("lists OpenCode's skills for OpenCode 2", () => {
    expect(getNativeChatAgentProfile('opencode2')).toMatchObject({ skillSourceOwner: 'opencode' })
  })

  it('does not grant custom or unverified agents a skill grammar', () => {
    expect(getNativeChatAgentProfile('custom-agent')).toBeNull()
  })
})

describe('host-claimed native chat commands', () => {
  function names(agent: string): string[] {
    return getHostClaimedNativeChatCommands(agent).map((command) => command.name)
  }

  // Claude expands slash commands from message text; host claiming produced false unavailable replies.
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

describe('native chat command replies', () => {
  it('declares /context as answered by the composer for OMP and by a transcript row for OpenClaude', () => {
    expect(getNativeChatCommandReply('omp', 'context')).toBe('composer')
    expect(getNativeChatCommandReply('openclaude', 'context')).toBe('transcript')
    // Claude and Codex answer /context in their structured sessions.
    expect(getNativeChatCommandReply('claude', 'context')).toBeNull()
    expect(getNativeChatCommandReply('codex', 'context')).toBeNull()
    expect(getNativeChatCommandReply('omp', 'compact')).toBeNull()
  })

  it('declares only /context, the one reply the desktop chat implements', () => {
    for (const agent of ['claude', 'openclaude', 'codex', 'omp', 'grok', 'custom-agent']) {
      const declared = getVerifiedNativeChatCommands(agent).filter(({ reply }) => reply)
      expect(declared.map(({ name }) => name)).toEqual(
        agent === 'omp' || agent === 'openclaude' ? ['context'] : []
      )
    }
  })

  it('leaves out of the agent-answered catalog only the commands that declare a reply', () => {
    const names = (agent: string) =>
      getAgentAnsweredNativeChatCommands(agent).map(({ name }) => name)
    expect(names('openclaude')).toEqual(names('claude'))
    expect(names('omp')).toEqual(
      getVerifiedNativeChatCommands('omp')
        .map(({ name }) => name)
        .filter((name) => name !== 'context')
    )
    expect(getAgentAnsweredNativeChatCommands('codex')).toEqual(
      getVerifiedNativeChatCommands('codex')
    )
  })
})
