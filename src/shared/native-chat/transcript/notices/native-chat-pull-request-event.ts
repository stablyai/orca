import {
  noteRevisedInPlace,
  revisedInPlace
} from '../../../agent-session/view/revised-in-place-lists'
import { parseAgentJournalItemKey } from '../../../agent-session/journal/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../native-chat-types'

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

export function pullRequestEventPullRequestUrl(event: PullRequestEventIdentity): string {
  return `https://${event.forgeHost}/${event.owner}/${event.repo}/pull/${event.number}`
}

export function pullRequestEventCommitUrl(event: PullRequestEventIdentity): string {
  return `https://${event.forgeHost}/${event.owner}/${event.repo}/commit/${event.headSha}`
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
  const patched = withoutPullRequestEventRevision(rows)
  if (patched) {
    return patched
  }
  if (!rows.messages.some(isPullRequestEventMessage)) {
    filteredRows.set(rows.messages, { turnKeys: rows.turnKeys, filtered: rows, kept: null })
    return rows
  }
  const messages: NativeChatMessage[] = []
  const turnKeys: (string | undefined)[] = []
  const kept: number[] = []
  rows.messages.forEach((message, index) => {
    if (isPullRequestEventMessage(message)) {
      kept.push(-1)
    } else {
      kept.push(messages.length)
      messages.push(message)
      turnKeys.push(rows.turnKeys[index])
    }
  })
  const filtered = { messages, turnKeys }
  filteredRows.set(rows.messages, { turnKeys: rows.turnKeys, filtered, kept })
  return filtered
}

// Per filtered list: the turn keys it was filtered with, what it gave, and each row's place in it.
const filteredRows = new WeakMap<
  readonly NativeChatMessage[],
  {
    turnKeys: readonly (string | undefined)[]
    filtered: { messages: readonly NativeChatMessage[]; turnKeys: readonly (string | undefined)[] }
    /** Each row's index in the filtered rows, or -1 for a dropped CI line; null when none dropped. */
    kept: readonly number[] | null
  }
>()

/** A list revised in place from one already filtered, with the same turns, is filtered by
 *  replacing only its revised rows, so a streaming reply costs no pass over history. */
function withoutPullRequestEventRevision(rows: {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
}): { messages: readonly NativeChatMessage[]; turnKeys: readonly (string | undefined)[] } | null {
  const revision = revisedInPlace(rows.messages)
  const prior = revision && filteredRows.get(revision.from)
  if (!revision || !prior || prior.turnKeys !== rows.turnKeys) {
    return null
  }
  if (prior.kept === null) {
    if (revision.at.some((index) => isPullRequestEventMessage(rows.messages[index]!))) {
      return null
    }
    filteredRows.set(rows.messages, prior)
    return rows
  }
  const messages = prior.filtered.messages.slice()
  const positions: number[] = []
  for (const index of revision.at) {
    const at = prior.kept[index]!
    const message = rows.messages[index]!
    if (isPullRequestEventMessage(message) !== (at === -1)) {
      return null
    }
    if (at !== -1) {
      messages[at] = message
      positions.push(at)
    }
  }
  noteRevisedInPlace(messages, prior.filtered.messages, positions)
  const filtered = { messages, turnKeys: prior.filtered.turnKeys }
  filteredRows.set(rows.messages, { turnKeys: rows.turnKeys, filtered, kept: prior.kept })
  return filtered
}

/** Messages without CI lines; the same array when there's nothing to drop, so identity checks hold. */
export function withoutPullRequestEventMessages<Messages extends readonly NativeChatMessage[]>(
  messages: Messages
): Messages | NativeChatMessage[] {
  let kept: NativeChatMessage[] | null = null
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (isPullRequestEventMessage(message)) {
      kept ??= messages.slice(0, index)
    } else {
      kept?.push(message)
    }
  }
  return kept ?? messages
}
