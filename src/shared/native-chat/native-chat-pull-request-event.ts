import { parseAgentJournalItemKey } from '../agent-session/journal/agent-session-journal-item-key'
import type { NativeChatMessage } from './native-chat-types'

/** A host status line about a finished CI result on a pull request a chat opened or pushed to. */
export const PULL_REQUEST_EVENT_PRESENTATION = 'pull-request-event'

export type PullRequestEventVerdict = 'failure' | 'success'

export type PullRequestEventIdentity = {
  forgeHost: string
  owner: string
  repo: string
  number: number
  headSha: string
  occurrence: number
}

const ID_PREFIX = 'pr-event:'
const ID_PATTERN = /^pr-event:([^/]+)\/([^/]+)\/([^/#]+)#(\d+):([0-9a-f]{7,64}):(\d+)$/u

export function pullRequestKey(pr: {
  forgeHost: string
  owner: string
  repo: string
  number: number
}): string {
  return `${pr.forgeHost}/${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()
}

/** The line's whole identity: older builds keep no saved field for it (strict storage refuses one). */
export function pullRequestEventClientMessageId(event: PullRequestEventIdentity): string {
  return `${ID_PREFIX}${pullRequestKey(event)}:${event.headSha.toLowerCase()}:${event.occurrence}`
}

export function parsePullRequestEventItemId(itemId: string): PullRequestEventIdentity | null {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return null
  }
  const match = ID_PATTERN.exec(identity.clientMessageId)
  if (!match) {
    return null
  }
  const [, forgeHost, owner, repo, number, headSha, occurrence] = match
  return {
    forgeHost: forgeHost!,
    owner: owner!,
    repo: repo!,
    number: Number(number),
    headSha: headSha!,
    occurrence: Number(occurrence)
  }
}

export function pullRequestEventShortSha(headSha: string): string {
  return headSha.slice(0, 7)
}

/** The text every client shows; newer desktops redraw it with links from the item's identity. */
export function pullRequestEventText(
  verdict: PullRequestEventVerdict,
  pr: { repo: string; number: number; headSha: string }
): string {
  const lead = verdict === 'failure' ? 'CI failing on' : 'CI green on'
  return `${lead} ${pr.repo}#${pr.number} at ${pullRequestEventShortSha(pr.headSha)}`
}

/** A CI result line: a client that doesn't show them drops the whole row. */
export function isPullRequestEventMessage(message: NativeChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) => block.type === 'text' && block.presentation === PULL_REQUEST_EVENT_PRESENTATION
    )
  )
}

/** Rows and their turn keys without CI lines, index-aligned as the transcript slots expect. */
export function withoutPullRequestEventRows(rows: {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
}): { messages: readonly NativeChatMessage[]; turnKeys: readonly (string | undefined)[] } {
  if (!rows.messages.some(isPullRequestEventMessage)) {
    return rows
  }
  const messages: NativeChatMessage[] = []
  const turnKeys: (string | undefined)[] = []
  rows.messages.forEach((message, index) => {
    if (!isPullRequestEventMessage(message)) {
      messages.push(message)
      turnKeys.push(rows.turnKeys[index])
    }
  })
  return { messages, turnKeys }
}
