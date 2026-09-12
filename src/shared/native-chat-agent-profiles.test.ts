import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_SUPPORTED_AGENT_LIST } from './native-chat-agent-support'
import {
  getHostClaimedNativeChatCommands,
  getNativeChatAgentProfile,
  getNativeChatAttachmentForm,
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

describe('native chat attachment form', () => {
  it.each([
    ['claude', 'image-paste'],
    ['openclaude', 'image-paste'],
    ['codex', 'image-paste'],
    ['grok', 'image-paste'],
    // OMP wraps Pi's TUI, which has no verified image-path paste gesture.
    ['omp', 'file-reference'],
    ['custom-agent', 'file-reference']
  ] as const)('%s attaches as %s', (agent, form) => {
    expect(getNativeChatAttachmentForm(agent)).toBe(form)
  })

  it('never leaves a native-chat agent without a form', () => {
    for (const agent of NATIVE_CHAT_SUPPORTED_AGENT_LIST) {
      expect(getNativeChatAttachmentForm(agent)).toMatch(/^(image-paste|file-reference)$/)
    }
  })

  it('does not give every native-chat agent the same form', () => {
    const forms = new Set(NATIVE_CHAT_SUPPORTED_AGENT_LIST.map(getNativeChatAttachmentForm))
    expect(forms.size).toBeGreaterThan(1)
  })

  it('falls back to the reference form for an unknown agent', () => {
    expect(getNativeChatAttachmentForm(null)).toBe('file-reference')
    expect(getNativeChatAttachmentForm(undefined)).toBe('file-reference')
  })
})
