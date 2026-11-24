// `orca bot work list`: the work a bot started, one line each, from its work record and orchestration.
import type { ConnectorSource } from '../connectors/external-conversation-link'
import { CONNECTOR_SOURCE_NAMES } from '../connectors/external-conversation-link'
import type { BotWorkPullRequest } from './bot-work-pull-request'
import type { OrchestrationSessionWorkerState } from '../orchestration-session-workers'

export type BotWorkerSummary = {
  /** The work record row. */
  id: string
  /** What the worker was asked to do. */
  title: string
  agent: string | null
  /** Null when orchestration can't be read now. */
  state: OrchestrationSessionWorkerState | null
  /** Its Dispatch is open but its agent waits, on its coordinator or an answer. */
  idle?: boolean
  dispatchId: string
  workspace: string | null
  /** The paired server it runs on. */
  server: string | null
  pr: BotWorkPullRequest | null
  startedAt: number | null
  closedAt?: number
  /** Where the turn that started it was asked: Orca itself (titled when it was one of the bot's
   *  chats), or a connector's conversation. */
  source: { source: ConnectorSource | 'app'; title: string | null }
}

export type BotWorkListResult = {
  items: BotWorkerSummary[]
  /** The workspaces under the bot, its workers' and those handed to it; absent when `worktree ps` failed. */
  workspaces?: { id: string; name: string; agent: string | null }[]
  /** The bot whose work this is. */
  botName: string
  historyIncluded?: boolean
}

const STATE_WORDS: Record<OrchestrationSessionWorkerState, string> = {
  working: 'working',
  completed: 'finished',
  failed: 'failed',
  stopped: 'stopped',
  unverifiable: 'out of contact'
}

// The PR's link only: its state and checks are a cached read that goes stale, so GitHub is the source.
function prWords(pr: BotWorkPullRequest): string {
  return `PR #${pr.number} ${pr.url}`
}

function age(startedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - startedAt) / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export function formatBotWorkerSummary(item: BotWorkerSummary, now: number): string {
  const who = `${item.title}${item.agent ? ` (${item.agent})` : ''}`
  const where = [item.workspace, item.server].filter(Boolean).join(' on ')
  const titled = item.source.title ? ` "${item.source.title}"` : ''
  const from =
    item.source.source === 'app'
      ? `from Orca${titled}`
      : `from ${CONNECTOR_SOURCE_NAMES[item.source.source]}${titled}`
  return [
    `${item.id} ${who}`,
    item.idle ? 'idle' : item.state ? STATE_WORDS[item.state] : 'state unknown',
    ...(item.closedAt === undefined ? [] : ['history']),
    ...(where ? [where] : []),
    ...(item.pr ? [prWords(item.pr)] : []),
    ...(item.startedAt !== null ? [age(item.startedAt, now)] : []),
    from,
    `dispatch:${item.dispatchId}`
  ].join(' · ')
}

export function formatBotWorkList(result: Omit<BotWorkListResult, 'botName'>, now: number): string {
  const work =
    result.items.length === 0
      ? 'No work started by this bot.'
      : result.items.map((item) => formatBotWorkerSummary(item, now)).join('\n')
  const workspaces = result.workspaces ?? []
  return workspaces.length === 0
    ? work
    : [
        work,
        '',
        'Workspaces under you:',
        ...workspaces.map(
          (entry) => `${entry.name} · ${entry.agent ?? 'no agent open'} · --worktree id:${entry.id}`
        )
      ].join('\n')
}
