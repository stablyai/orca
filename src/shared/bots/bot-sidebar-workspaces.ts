import type { WorktreeStatus } from '../worktree/row-display/worktree-status-rollup'

/** Lines a bot shows before "Show N more". */
export const BOT_ACTIVE_WORKSPACE_LINE_LIMIT = 8

/** The lines shown before "Show N more": the first few, plus the open one wherever it ranks. */
export function capBotWorkspaceLines<T>(workspaces: readonly T[], open: T | undefined): T[] {
  return workspaces.filter(
    (workspace, index) => index < BOT_ACTIVE_WORKSPACE_LINE_LIMIT || workspace === open
  )
}

export type BotWorkspaceLiveCounts = { permission: number; working: number; failed: number }

/** What a folded bot row shows: how many of its workspaces need you, are working, or failed. */
export function countLiveBotWorkspaces(
  statuses: readonly WorktreeStatus[]
): BotWorkspaceLiveCounts {
  const counts: BotWorkspaceLiveCounts = { permission: 0, working: 0, failed: 0 }
  for (const status of statuses) {
    if (status === 'permission') {
      counts.permission += 1
    } else if (status === 'working' || status === 'monitoring') {
      counts.working += 1
    } else if (status === 'failed') {
      counts.failed += 1
    }
  }
  return counts
}

/** A folded bot's glyph: its most urgent live workspace's status, or none. */
export function botFoldLiveStatus(
  counts: BotWorkspaceLiveCounts
): 'permission' | 'working' | 'failed' | null {
  return (['permission', 'working', 'failed'] as const).find((status) => counts[status] > 0) ?? null
}

/** The bot's dot: the busiest of the bot and its workspaces, needs you over working. */
export function rollUpBotStatus(
  own: WorktreeStatus,
  workspaces: readonly WorktreeStatus[]
): WorktreeStatus {
  const all = [own, ...workspaces]
  if (all.includes('permission')) {
    return 'permission'
  }
  return all.find((status) => status === 'working' || status === 'monitoring') ?? own
}

/** Agent kinds a bot worker line shows by logo before "+N". */
export const BOT_WORKSPACE_LINE_AGENT_KINDS = 2
/** A worker line's logos overlap as a small stack: each logo's size, how far the next one starts, and the clear gap between them. */
export const BOT_WORKSPACE_LINE_LOGO = { size: 12, step: 8, gap: 1.5 } as const

/** A bot worker line's agents: a logo per kind, then "+N" for the agents of kinds left out. */
export type BotWorkspaceLineAgent = {
  /** Kinds by how many of its agents run them, first seen on a tie; unknown when none is identified. */
  agentTypes: string[]
  /** Its agents whose kind has no logo. */
  others: number
  /** One of those others is waiting on the owner. */
  othersNeedYou: boolean
}

type LineAgentInput = { agentType: string | null | undefined; subagent: boolean; state: string }

const needsYou = (agent: LineAgentInput): boolean =>
  agent.state === 'blocked' || agent.state === 'waiting'

const kindOf = (agent: LineAgentInput): string =>
  agent.agentType && agent.agentType !== 'unknown' ? agent.agentType : 'unknown'

/** Top-level agents only: a subagent works for its parent. Null when no agent works there. */
export function botWorkspaceLineAgent(
  agents: readonly LineAgentInput[]
): BotWorkspaceLineAgent | null {
  const own = agents.filter((agent) => !agent.subagent)
  if (own.length === 0) {
    return null
  }
  const counts = new Map<string, number>()
  for (const agent of own) {
    const kind = kindOf(agent)
    if (kind !== 'unknown') {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  }
  // Stable sort keeps first-seen order on a tie.
  const kinds = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!)
  const agentTypes = kinds.length > 0 ? kinds.slice(0, BOT_WORKSPACE_LINE_AGENT_KINDS) : ['unknown']
  const others = own.filter((agent) => !agentTypes.includes(kindOf(agent)))
  return { agentTypes, others: others.length, othersNeedYou: others.some(needsYou) }
}
