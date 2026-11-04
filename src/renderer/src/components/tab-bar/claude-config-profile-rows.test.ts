import { describe, expect, it } from 'vitest'
import { withClaudeConfigProfileRows } from './claude-config-profile-rows'

const profiles = [{ id: 'work', label: 'work', configDir: '/Users/me/.claude-work' }]

describe('Claude profile menu rows', () => {
  it('starts the terminal group when Claude itself opens as a chat', () => {
    expect(
      withClaudeConfigProfileRows(
        [
          { kind: 'chat', agent: 'claude' },
          { kind: 'chat', agent: 'codex' },
          { kind: 'cli', agent: 'gemini' }
        ],
        profiles,
        ['claude', 'codex', 'gemini']
      )
    ).toEqual([
      { kind: 'chat', agent: 'claude' },
      { kind: 'chat', agent: 'codex' },
      { kind: 'cli', agent: 'claude', claudeConfigProfile: { id: 'work', label: 'work' } },
      { kind: 'cli', agent: 'gemini' }
    ])
  })

  it('offers no profile on an SSH host, where the folder does not exist', () => {
    const rows = [
      { kind: 'cli' as const, agent: 'claude' as const, executionHostId: 'ssh:box' as const }
    ]
    expect(withClaudeConfigProfileRows(rows, profiles, ['claude'])).toEqual(rows)
  })
})
