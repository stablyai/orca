import { describe, expect, it } from 'vitest'
import {
  buildTabAgentLaunchOptions,
  findMatchingTabAgentLaunchOptions,
  orderTabLaunchAgents
} from './tab-agent-launch-options'
import type { CustomTuiAgent } from '../../../../shared/types'

describe('tab agent launch options', () => {
  it('orders detected agents by the configured default first', () => {
    expect(orderTabLaunchAgents('codex', ['claude', 'codex', 'gemini'])).toEqual([
      'codex',
      'claude',
      'gemini'
    ])
  })

  it('keeps ready custom agents searchable in the new tab launcher', () => {
    const customAgents: CustomTuiAgent[] = [
      {
        id: 'custom:zeta-abc123',
        label: 'Zeta Wrapper',
        command: 'codex --profile zeta',
        promptInjectionMode: 'stdin-after-start'
      },
      {
        id: 'custom:alpha-abc123',
        label: 'Alpha Wrapper',
        command: 'alpha-agent',
        promptInjectionMode: 'stdin-after-start'
      },
      {
        id: 'custom:empty-abc123',
        label: 'Empty Wrapper',
        command: '',
        promptInjectionMode: 'stdin-after-start'
      }
    ]

    const ordered = orderTabLaunchAgents('custom:alpha-abc123', ['claude', 'codex'], customAgents)

    expect(ordered).toEqual(['custom:alpha-abc123', 'claude', 'codex', 'custom:zeta-abc123'])
    const options = buildTabAgentLaunchOptions(ordered, {}, customAgents)
    expect(
      findMatchingTabAgentLaunchOptions('Alpha Wrapper', options).map((option) => option.agent)
    ).toEqual(['custom:alpha-abc123'])
    expect(
      findMatchingTabAgentLaunchOptions('codex --profile zeta', options).map(
        (option) => option.agent
      )
    ).toEqual(['custom:zeta-abc123'])
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
})
