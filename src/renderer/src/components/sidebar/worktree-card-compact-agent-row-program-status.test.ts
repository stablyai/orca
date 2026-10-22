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

describe("the sidebar row's secondary line with an OSC 7501 facet", () => {
  it("shows the program's line when the hook row has no tool preview", () => {
    const agent = row({
      programStatus: { state: 'working', message: 'Running tests', observedAt: NOW }
    })
    expect(getCompactAgentSecondary(agent, NOW)).toBe('Running tests')
  })

  it('keeps the hook tool preview ahead of the program line', () => {
    const agent = row({
      toolName: 'Edit',
      toolInput: 'src/app.ts',
      programStatus: { state: 'working', message: 'Editing', observedAt: NOW }
    })
    expect(getCompactAgentSecondary(agent, NOW)).toBe('Edit: src/app.ts')
  })

  it('leads with a sign-in block the hook row does not show', () => {
    const agent = row({
      state: 'done',
      programStatus: { state: 'blocked', kind: 'auth', message: 'Session expired', observedAt: NOW }
    })
    expect(getCompactAgentSecondary(agent, NOW)).toBe('Sign-in required: Session expired')
  })
})
