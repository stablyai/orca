import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makeTab } from '../../store/slices/store-session-test-harness'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { getCompactAgentSecondary } from './worktree-card-compact-agent-row'

const NOW = new Date('2026-05-04T12:00:00.000Z').getTime()
const TAB_ID = 'tab-1'

function row(overrides: Partial<AgentStatusEntry>) {
  const [agent] = buildWorktreeAgentRows({
    tabs: [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })],
    entries: [
      {
        paneKey: `${TAB_ID}:11111111-1111-4111-8111-111111111111`,
        state: 'working',
        prompt: 'ship it',
        updatedAt: NOW,
        stateStartedAt: NOW,
        stateHistory: [],
        agentType: 'claude',
        ...overrides
      }
    ],
    retained: [],
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    now: NOW
  })
  if (!agent) {
    throw new Error('expected one agent row')
  }
  return agent
}

describe('compact agent secondary live worktree mismatch', () => {
  it('prefixes the mismatch in front of the existing secondary line', () => {
    const agent = row({ toolName: 'Edit', toolInput: 'src/a.ts' })
    const detail = getCompactAgentSecondary(agent, NOW)
    expect(detail).toBe('Edit: src/a.ts')
    expect(
      getCompactAgentSecondary({ ...agent, liveWorktreeMismatchLabel: 'in worktree-foo' }, NOW)
    ).toBe('in worktree-foo · Edit: src/a.ts')
  })

  it('leads with the mismatch when the row has no tool line', () => {
    const agent = row({ state: 'waiting' })
    const detail = getCompactAgentSecondary(agent, NOW)
    expect(
      getCompactAgentSecondary({ ...agent, liveWorktreeMismatchLabel: 'in worktree-foo' }, NOW)
    ).toBe(detail ? `in worktree-foo · ${detail}` : 'in worktree-foo')
  })

  it('leaves the secondary line unchanged when there is no mismatch', () => {
    const agent = row({ toolName: 'Bash' })
    expect(getCompactAgentSecondary(agent, NOW)).toBe('Bash')
  })
})
