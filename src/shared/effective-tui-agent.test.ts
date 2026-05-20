import { describe, expect, it } from 'vitest'

import {
  firstExecutableToken,
  generateCustomTuiAgentId,
  getEffectiveTuiAgent,
  isCustomTuiAgentId,
  listEffectiveTuiAgents
} from './effective-tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { CustomTuiAgent } from './types'

const sampleCustom: CustomTuiAgent = {
  id: 'custom:my-wrapper-abc123',
  label: 'My Wrapper',
  command: 'npx -y my-wrapper',
  promptInjectionMode: 'stdin-after-start'
}

describe('isCustomTuiAgentId', () => {
  it('accepts strings starting with custom:', () => {
    expect(isCustomTuiAgentId('custom:foo-abc123')).toBe(true)
  })

  it('rejects built-in ids and non-strings', () => {
    expect(isCustomTuiAgentId('claude')).toBe(false)
    expect(isCustomTuiAgentId('blank')).toBe(false)
    expect(isCustomTuiAgentId(null)).toBe(false)
    expect(isCustomTuiAgentId(42)).toBe(false)
  })
})

describe('firstExecutableToken', () => {
  it('returns the first whitespace-separated token', () => {
    expect(firstExecutableToken('npx -y foo')).toBe('npx')
  })

  it('strips path prefixes', () => {
    expect(firstExecutableToken('/usr/bin/zsh -l')).toBe('zsh')
    expect(firstExecutableToken('C:\\Tools\\my.exe --flag')).toBe('my.exe')
  })

  it('returns empty string for blank input', () => {
    expect(firstExecutableToken('')).toBe('')
    expect(firstExecutableToken('   ')).toBe('')
  })
})

describe('getEffectiveTuiAgent', () => {
  it('returns built-in shape for a TuiAgent id', () => {
    const effective = getEffectiveTuiAgent('claude', [])
    expect(effective).not.toBeNull()
    expect(effective?.isCustom).toBe(false)
    expect(effective?.launchCmd).toBe(TUI_AGENT_CONFIG.claude.launchCmd)
  })

  it('returns custom shape for a known custom id', () => {
    const effective = getEffectiveTuiAgent(sampleCustom.id, [sampleCustom])
    expect(effective).not.toBeNull()
    expect(effective?.isCustom).toBe(true)
    expect(effective?.label).toBe('My Wrapper')
    expect(effective?.launchCmd).toBe('npx -y my-wrapper')
  })

  it('derives detectCmd and expectedProcess from the command when omitted', () => {
    const effective = getEffectiveTuiAgent(sampleCustom.id, [sampleCustom])
    expect(effective?.detectCmd).toBe('npx')
    expect(effective?.expectedProcess).toBe('npx')
  })

  it('honors explicit detectCmd and expectedProcess', () => {
    const withOverrides: CustomTuiAgent = {
      ...sampleCustom,
      detectCmd: 'my-wrapper',
      expectedProcess: 'node'
    }
    const effective = getEffectiveTuiAgent(withOverrides.id, [withOverrides])
    expect(effective?.detectCmd).toBe('my-wrapper')
    expect(effective?.expectedProcess).toBe('node')
  })

  it('returns null for an unknown custom id', () => {
    expect(getEffectiveTuiAgent('custom:missing-zzz999', [])).toBeNull()
  })

  it('returns null for a string that is not a valid built-in or custom id', () => {
    expect(getEffectiveTuiAgent('not-a-real-agent' as 'claude', [])).toBeNull()
  })
})

describe('listEffectiveTuiAgents', () => {
  it('returns every built-in plus every custom agent', () => {
    const list = listEffectiveTuiAgents([sampleCustom])
    const builtInCount = Object.keys(TUI_AGENT_CONFIG).length
    expect(list).toHaveLength(builtInCount + 1)
    expect(list.some((agent) => agent.id === sampleCustom.id)).toBe(true)
  })
})

describe('generateCustomTuiAgentId', () => {
  it('produces the custom:<slug>-<6char> shape', () => {
    const id = generateCustomTuiAgentId('My Wrapper')
    expect(id).toMatch(/^custom:my-wrapper-[a-z0-9]{6}$/)
  })

  it('falls back to "agent" for empty or symbol-only labels', () => {
    expect(generateCustomTuiAgentId('')).toMatch(/^custom:agent-[a-z0-9]{6}$/)
    expect(generateCustomTuiAgentId('   ')).toMatch(/^custom:agent-[a-z0-9]{6}$/)
    expect(generateCustomTuiAgentId('!!!')).toMatch(/^custom:agent-[a-z0-9]{6}$/)
  })

  it('truncates very long slugs', () => {
    const id = generateCustomTuiAgentId('a'.repeat(80))
    const match = id.match(/^custom:(.+)-[a-z0-9]{6}$/)
    expect(match).not.toBeNull()
    expect((match?.[1] ?? '').length).toBeLessThanOrEqual(24)
  })

  it('is highly unique across many calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateCustomTuiAgentId('My Wrapper'))
    }
    // 36^6 ~= 2 billion possibilities; 1000 draws should not collide.
    expect(seen.size).toBe(1000)
  })
})
