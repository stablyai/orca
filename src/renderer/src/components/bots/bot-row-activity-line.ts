// A bot row's second line on the desktop: the shared pick (`selectBotRowLine`) read from the window's
// agent rows, as a workspace's agent row says them.
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import type { Translate } from '@/i18n/use-translate'
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

// Built per call on the render's t: React Compiler memoizes the pick on its inputs, so a status read
// through module translate() ("Stopping…", "Monitoring background tasks") kept the previous
// language after a switch until the rows or the minute tick changed.
function desktopRows(t: Translate): BotRowLineReader<DashboardAgentRow> {
  return {
    paneKey: (row) => row.paneKey,
    subagent: (row) => row.rowSource === 'subagent',
    // Working, or stopped on a question for the owner.
    live: (row) => row.state === 'working' || row.state === 'blocked' || row.state === 'waiting',
    needsYou: (row) => row.state === 'blocked' || row.state === 'waiting',
    updatedAt: (row) => row.entry.updatedAt,
    status: (row, now) => getCompactAgentStatus(row, now, undefined, undefined, t),
    at: (row) => getCompactAgentTimestamp(row)
  }
}

/** The shared pick, read from the window's agent rows, its status labels said with `t`. */
export function selectBotRowLine(input: BotRowLineInput, t: Translate): BotRowLine | null {
  return selectSharedBotRowLine(input, desktopRows(t))
}
