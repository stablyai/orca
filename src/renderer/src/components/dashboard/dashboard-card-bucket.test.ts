import { describe, expect, it } from 'vitest'
import { agentVerdictDisplayMark } from '../../../../shared/agent-main-agent-verdict'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { dashboardCardDisplayState } from '../../../../shared/dashboard-snapshot'
import type { AgentMainAgentStatus } from '../../../../shared/main-agent-status'
import {
  applyAgentPaneActivityFlags,
  type AgentPaneActivityFlags
} from '@/lib/agent-pane-activity-flags'
import { agentRowDotState } from '@/lib/agent-row-dot-state'
import { resolveWorktreeStatus } from '@/lib/worktree-status'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'

const PANE_KEY = 'tab-1:leaf-1'
const failed: AgentMainAgentStatus = { state: 'done', outcome: 'failure', stateStartedAt: 1_000 }
const stopped: AgentMainAgentStatus = {
  state: 'done',
  outcome: 'cancellation',
  stateStartedAt: 1_000
}

type Scenario = Pick<AgentStatusEntry, 'state' | 'workingMode' | 'mainAgent'>

const SCENARIOS: Record<string, Scenario> = {
  'clean done': { state: 'done' },
  failed: { state: 'done', mainAgent: failed },
  stopped: { state: 'done', mainAgent: stopped },
  'failed with a working subagent': { state: 'working', mainAgent: failed },
  "failed with a subagent's waiting question": { state: 'waiting', mainAgent: failed },
  "failed with a subagent's blocked question": { state: 'blocked', mainAgent: failed },
  'stopped with a working subagent': { state: 'working', mainAgent: stopped },
  working: { state: 'working' },
  monitoring: { state: 'working', workingMode: 'monitoring' },
  waiting: { state: 'waiting' },
  blocked: { state: 'blocked' }
}

function worktreeStatusFor(entry: AgentStatusEntry) {
  const flags: AgentPaneActivityFlags = {
    hasPermission: false,
    hasLiveWorking: false,
    hasLiveMonitoring: false,
    hasFailed: false,
    hasInterrupted: false,
    hasLiveDone: false
  }
  applyAgentPaneActivityFlags(flags, entry)
  return resolveWorktreeStatus({
    tabs: [],
    browserTabs: [],
    ptyIdsByTabId: {},
    ...flags,
    hasRetainedDone: false
  })
}

// Why: pins the pop-out's own column rule to the desktop worktree card's ladder, so a new
// precedence on either side fails here instead of in a review loop.
describe('pop-out card parity with the desktop agent row and worktree card', () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    for (const seen of [false, true]) {
      it(`${name}, ${seen ? 'seen' : 'unseen'}`, () => {
        const entry: AgentStatusEntry = {
          paneKey: PANE_KEY,
          prompt: 'do the thing',
          updatedAt: 2_000,
          stateStartedAt: 1_000,
          stateHistory: [],
          ...scenario
        }
        const card = dashboardRowBucketProjection(
          { paneKey: PANE_KEY, entry, state: entry.state, startedAt: 1_000 },
          seen ? { [PANE_KEY]: 5_000 } : {}
        )
        expect(card.unseen).toBe(!seen)

        // The desktop row's dot, as DashboardAgentRow draws it; only the pop-out settles a seen
        // clean completion into idle.
        const rowDot =
          agentVerdictDisplayMark(entry) ?? agentRowDotState(entry.state, entry.workingMode)
        expect(dashboardCardDisplayState(card)).toBe(rowDot === 'done' && seen ? 'idle' : rowDot)

        const worktree = worktreeStatusFor(entry)
        if (worktree === 'permission') {
          expect(card.bucket).toBe('attention')
        } else if (worktree === 'working' || worktree === 'monitoring') {
          expect(card.bucket).toBe('working')
        } else {
          // A failure whose subagents still work stays under Done even once seen.
          expect(card.bucket).toBe(seen && entry.state === 'done' ? 'idle' : 'done')
        }
      })
    }
  }
})
