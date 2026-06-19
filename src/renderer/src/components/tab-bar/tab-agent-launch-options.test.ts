import { describe, expect, it } from 'vitest'
import { getAgentCatalogWithProfiles } from '@/lib/agent-catalog'
import {
  buildTabAgentLaunchOptions,
  findMatchingTabAgentLaunchOptions,
  orderTabLaunchAgents
} from './tab-agent-launch-options'

describe('tab agent launch options', () => {
  it('orders detected agents by the configured default first', () => {
    expect(orderTabLaunchAgents('codex', ['claude', 'codex', 'gemini'])).toEqual([
      'codex',
      'claude',
      'gemini'
    ])
  })

  it('matches detected agents by id, label, command, and command override', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'antigravity'], {
      codex: 'codex-beta'
    })

    expect(
      findMatchingTabAgentLaunchOptions('Claude', options).map((option) => option.agent)
    ).toEqual(['claude'])
    expect(findMatchingTabAgentLaunchOptions('openai codex', options)).toEqual([])
    expect(
      findMatchingTabAgentLaunchOptions('codex-beta', options).map((option) => option.agent)
    ).toEqual(['codex'])
    expect(findMatchingTabAgentLaunchOptions('agy', options).map((option) => option.agent)).toEqual(
      ['antigravity']
    )
  })

  it('orders and matches profiles when their base agent is detected', () => {
    const profiles = [
      {
        id: 'agent-profile:claude-foo' as const,
        baseAgent: 'claude' as const,
        label: 'Claude (foo)',
        defaultArgs: '--foo'
      }
    ]
    const ordered = orderTabLaunchAgents('agent-profile:claude-foo', ['claude'], profiles)
    const options = buildTabAgentLaunchOptions(ordered, {}, profiles)

    expect(ordered).toEqual(['agent-profile:claude-foo', 'claude'])
    expect(
      findMatchingTabAgentLaunchOptions('Claude (foo)', options).map((option) => option.agent)
    ).toEqual(['agent-profile:claude-foo'])
  })

  it('keeps profiles directly beneath their base agent in catalog order', () => {
    const profiles = [
      {
        id: 'agent-profile:claude-foo' as const,
        baseAgent: 'claude' as const,
        label: 'Claude (foo)'
      }
    ]

    expect(orderTabLaunchAgents(null, ['claude', 'codex'], profiles)).toEqual([
      'claude',
      'agent-profile:claude-foo',
      'codex'
    ])
  })

  it('does not use profile default args as the catalog command fallback', () => {
    const [profile] = getAgentCatalogWithProfiles([
      {
        id: 'agent-profile:claude-foo' as const,
        baseAgent: 'claude' as const,
        label: 'Claude (foo)',
        defaultArgs: '--model sonnet'
      }
    ]).filter((agent) => agent.id === 'agent-profile:claude-foo')

    expect(profile.cmd).toBe('claude')
  })
})
