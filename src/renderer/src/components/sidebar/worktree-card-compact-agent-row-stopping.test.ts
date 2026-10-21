import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makeTab } from '../../store/slices/store-session-test-harness'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { getAgentDotState } from './worktree-card-agent-summary'
import { getCompactAgentLineOrder } from './worktree-card-compact-agent-line-order'
import { getCompactAgentSecondary } from './worktree-card-compact-agent-row'

const NOW = new Date('2026-05-04T12:00:00.000Z').getTime()
const TAB_ID = 'tab-1'

function row(mainAgent: AgentStatusEntry['mainAgent']) {
  const [agent] = buildWorktreeAgentRows({
    tabs: [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })],
    entries: [
      {
        paneKey: `${TAB_ID}:11111111-1111-4111-8111-111111111111`,
        state: 'working',
        prompt: 'run the long build',
        toolName: 'Bash',
        toolInput: 'pnpm test',
        updatedAt: NOW,
        stateStartedAt: NOW,
        stateHistory: [],
        agentType: 'claude',
        mainAgent
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

describe("the sidebar row while a person's Stop ends the turn", () => {
  it('says Stopping in place of the last tool line, and keeps the working spinner', () => {
    const stopping = row({ state: 'working', stopping: true, stateStartedAt: NOW })

    expect(getCompactAgentSecondary(stopping, NOW)).toBe('Stopping…')
    expect(getAgentDotState(stopping)).toBe('working')
  })

  it('shows the tool line otherwise', () => {
    expect(getCompactAgentSecondary(row({ state: 'working', stateStartedAt: NOW }), NOW)).not.toBe(
      'Stopping…'
    )
  })

  // The row truncates its one line from the end, and the model and time keep their room.
  it('leads with Stopping so a narrow sidebar cuts the chat name, not the status', () => {
    const stopping = row({ state: 'working', stopping: true, stateStartedAt: NOW })
    const secondary = getCompactAgentSecondary(stopping, NOW)

    expect(
      getCompactAgentLineOrder(stopping, getAgentDotState(stopping), 'Codex Chat', secondary)
    ).toEqual({ leadingText: 'Stopping…', trailingText: 'Codex Chat' })
  })

  it('leads with the chat name otherwise', () => {
    const working = row({ state: 'working', stateStartedAt: NOW })
    const secondary = getCompactAgentSecondary(working, NOW)

    expect(
      getCompactAgentLineOrder(working, getAgentDotState(working), 'Codex Chat', secondary)
    ).toEqual({ leadingText: 'Codex Chat', trailingText: secondary })
  })
})
