// Orca's turn handing an agent a workspace: the chat draws it as a divider naming the workspace, and the
// owner's goal (if any) as their own words, never as the turn's text, which is the agent's context.
import type { AgentJournalItemBody } from '../agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from './native-chat-types'

/** What the divider and the goal show. `home` marks the agent's first chat; the renderer no longer reads
 *  it, but hosts still write it for older peers. Host-written beside the `took-over` origin. */
export type TookOverNotice = { workspace: string; goal?: string; home?: true }

/** How the turn's text starts and where the owner's words begin in it, so status can name it. */
export const TOOK_OVER_TURN_PREFIX = '[Orca: your owner just handed you the workspace '
export const TOOK_OVER_GOAL_HEADING = "Your owner's words:\n\n"

export function readTookOverNotice(value: unknown): TookOverNotice | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const fields: Record<string, unknown> = { ...value }
  if (typeof fields.workspace !== 'string' || !fields.workspace) {
    return null
  }
  return {
    workspace: fields.workspace,
    ...(typeof fields.goal === 'string' && fields.goal ? { goal: fields.goal } : {}),
    ...(fields.home === true ? { home: true as const } : {})
  }
}

/** The divider's words, and a status line's when no goal came with it. */
export function tookOverLabel(workspace: string): string {
  return `Took over ${workspace}`
}

type MessageBody = Extract<AgentJournalItemBody, { kind: 'message' }>

/** A chat list's prompt for the turn: the owner's goal, else the divider's words; null for any other. */
export function tookOverPrompt(body: MessageBody): string | null {
  if (body.origin !== 'took-over') {
    return null
  }
  const notice = readTookOverNotice(body.tookOver)
  return notice ? (notice.goal ?? tookOverLabel(notice.workspace)) : ''
}

/** The turn's words as the chat shows them: the owner's goal; null when it has none to show. */
export function tookOverGoalBlocks(body: AgentJournalItemBody): NativeChatBlock[] | null {
  const goal =
    body.kind === 'message' && body.origin === 'took-over'
      ? readTookOverNotice(body.tookOver)?.goal
      : undefined
  return goal ? [{ type: 'text', text: goal }] : null
}

/** Status for the turn, which a hook reports as the agent's prompt: the owner's goal, else the
 *  divider's words; null for any other prompt. */
export function tookOverStatusLabel(prompt: string): string | null {
  const text = prompt.trim()
  if (!text.startsWith(TOOK_OVER_TURN_PREFIX)) {
    return null
  }
  const goal = text.indexOf(TOOK_OVER_GOAL_HEADING)
  if (goal !== -1) {
    return text.slice(goal + TOOK_OVER_GOAL_HEADING.length)
  }
  const end = text.indexOf(' (id:')
  return tookOverLabel(text.slice(TOOK_OVER_TURN_PREFIX.length, end === -1 ? undefined : end))
}
