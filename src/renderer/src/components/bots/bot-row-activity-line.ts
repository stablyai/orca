// A bot row's second line on the desktop: the shared pick (`selectBotRowLine`) read from the window's
// agent rows, as a workspace's agent row says them.
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import {
  getCompactAgentStatus,
  getCompactAgentTimestamp
} from '@/components/sidebar/workspace-card/activity/worktree-card-compact-agent-row'
import {
  selectBotRowLine as selectSharedBotRowLine,
  type BotRowLine,
  type BotRowLineInput as SharedBotRowLineInput,
  type BotRowLineReader
} from '../../../../shared/bots/bot-row-line'

export type { BotRowLine, BotRowPlace } from '../../../../shared/bots/bot-row-line'
export type BotRowLineInput = SharedBotRowLineInput<DashboardAgentRow>

const DESKTOP_ROWS: BotRowLineReader<DashboardAgentRow> = {
  paneKey: (row) => row.paneKey,
  subagent: (row) => row.rowSource === 'subagent',
  // Working, or stopped on a question for the owner.
  live: (row) => row.state === 'working' || row.state === 'blocked' || row.state === 'waiting',
  needsYou: (row) => row.state === 'blocked' || row.state === 'waiting',
  updatedAt: (row) => row.entry.updatedAt,
  status: (row, now) => getCompactAgentStatus(row, now),
  at: (row) => getCompactAgentTimestamp(row)
}

/** The shared pick, read from the window's agent rows. */
export function selectBotRowLine(input: BotRowLineInput): BotRowLine | null {
  return selectSharedBotRowLine(input, DESKTOP_ROWS)
}
