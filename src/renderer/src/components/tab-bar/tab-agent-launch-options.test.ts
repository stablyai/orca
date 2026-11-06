import { describe, expect, it } from 'vitest'
import {
  buildTabAgentLaunchOptions,
  buildTabAgentLaunchOptionsFromRows,
  findMatchingTabAgentLaunchOptions
} from './tab-agent-launch-options'

describe('tab agent launch options', () => {
  it('ranks an exact alias above weaker prefix matches', () => {
    const options = buildTabAgentLaunchOptions(['codebuff', 'codex', 'copilot'], {
      codebuff: 'codex-tools'
    })

    // The weaker codex-tools prefix starts first, so exact codex must move ahead.
    expect(findMatchingTabAgentLaunchOptions('codex', options)[0]?.agent).toBe('codex')
    expect(findMatchingTabAgentLaunchOptions('co', options).map((o) => o.agent)).toEqual(
      expect.arrayContaining(['codex', 'copilot', 'codebuff'])
    )
  })

  it('does not match on a mid-string substring that would hijack file results', () => {
    const options = buildTabAgentLaunchOptions(['opencode', 'claude'])

    // Agent rows outrank files, so broad mid-string hits must not hijack the result list.
    expect(findMatchingTabAgentLaunchOptions('ode', options)).toEqual([])
  })
})

it('projects the same CLI label, unavailable reason and stable chat ID as static rows', () => {
  const unavailable = buildTabAgentLaunchOptionsFromRows([
    { kind: 'chat-unavailable', agent: 'claude', reason: 'ssh' },
    { kind: 'cli', agent: 'claude' },
    { kind: 'cli', agent: 'codex', chat: true }
  ])
  expect(unavailable).toMatchObject([
    { id: 'chat:claude', label: 'Claude', reason: 'No chat over SSH', disabled: true },
    { id: 'cli:claude', label: 'Claude (CLI)', disabled: false },
    { id: 'cli:codex', label: 'Codex (CLI)', disabled: false }
  ])
  // Typing the agent's name and pressing Enter launches its CLI, not the disabled chat.
  expect(findMatchingTabAgentLaunchOptions('claude', unavailable)[0]?.id).toBe('cli:claude')
  expect(
    findMatchingTabAgentLaunchOptions('codex', unavailable).map((option) => [
      option.id,
      option.row?.kind
    ])
  ).toEqual([['cli:codex', 'cli']])
})
