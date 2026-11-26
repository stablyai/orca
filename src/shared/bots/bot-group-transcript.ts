import type { BotGroup, BotGroupMessage } from './bot-group'

export type BotGroupTranscript = {
  group: BotGroup
  messages: BotGroupMessage[]
  hasEarlier: boolean
  updatedPosts?: BotGroupMessage[]
  deferredPostIds?: string[]
}

/** Pending posts already on screen can settle while the reader is disconnected. */
export function pendingBotGroupPosts(page: BotGroupTranscript | null, groupId: string): string[] {
  if (page?.group.id !== groupId) {
    return []
  }
  return page.messages.flatMap((post) =>
    post.turns.some(
      (turn) => !turn.revoked && !turn.error && turn.end === undefined && turn.reply === undefined
    )
      ? [post.id]
      : []
  )
}

/** Drain named updates already requested by this read without reading older history pages. */
export async function drainBotGroupPostUpdates(
  ids: readonly string[],
  read: (ids: string[]) => Promise<BotGroupTranscript>,
  isCurrent: () => boolean,
  publish: (page: BotGroupTranscript, remaining: string[]) => void
): Promise<void> {
  let pending = [...new Set(ids)]
  while (isCurrent() && pending.length > 0) {
    const batch = pending.slice(0, 40)
    const page = await read(batch)
    if (!isCurrent()) {
      return
    }
    const deferred = page.deferredPostIds ?? []
    if (deferred.length >= batch.length) {
      return
    }
    pending = [...deferred, ...pending.slice(40)]
    publish(page, pending)
  }
}

export function botGroupReplyBodies(page: BotGroupTranscript): ReadonlyMap<string, string> {
  const replies = new Map<string, string>()
  for (const message of [...(page.updatedPosts ?? []), ...page.messages]) {
    for (const turn of message.turns) {
      if (turn.replyKey && typeof turn.reply === 'string') {
        replies.set(turn.replyKey, turn.reply)
      }
    }
  }
  return replies
}

export function restoreBotGroupReplies(
  page: BotGroupTranscript,
  replies: ReadonlyMap<string, string>
): BotGroupTranscript {
  const restore = (messages: BotGroupMessage[]) =>
    messages.map((message) => ({
      ...message,
      turns: message.turns.map((turn) => {
        const reply =
          turn.replyKey && turn.reply === undefined ? replies.get(turn.replyKey) : undefined
        return reply === undefined ? turn : { ...turn, reply }
      })
    }))
  return {
    ...page,
    messages: restore(page.messages),
    ...(page.updatedPosts ? { updatedPosts: restore(page.updatedPosts) } : {})
  }
}

export type BotGroupTranscriptAction =
  /** The latest page from a read. */
  | { kind: 'recent'; page: BotGroupTranscript }
  /** An older page, loaded on request. */
  | { kind: 'earlier'; page: BotGroupTranscript }
  | { kind: 'updated'; page: BotGroupTranscript }
  | { kind: 'sent'; message: BotGroupMessage }
  | { kind: 'group'; group: BotGroup }

function upsert(
  messages: readonly BotGroupMessage[],
  incoming: readonly BotGroupMessage[],
  updates: readonly BotGroupMessage[] = []
): BotGroupMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]))
  for (const message of updates) {
    if (byId.has(message.id)) {
      byId.set(message.id, message)
    }
  }
  for (const message of incoming) {
    byId.set(message.id, message)
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

function sameMembers(left: BotGroup, right: BotGroup): boolean {
  const sessions = new Set(left.members.map((member) => member.sessionId))
  return (
    left.members.length === right.members.length &&
    right.members.every((member) => sessions.has(member.sessionId))
  )
}

/** How newer metadata lands: older revisions are stale, and a member change voids loaded rows. */
function acceptance(current: BotGroupTranscript, group: BotGroup): 'stale' | 'members' | 'same' {
  return group.revision < current.group.revision
    ? 'stale'
    : sameMembers(current.group, group)
      ? 'same'
      : 'members'
}

/** The one place a room's loaded transcript changes, shared by desktop and mobile. */
export function reduceBotGroupTranscript(
  current: BotGroupTranscript | null,
  action: BotGroupTranscriptAction
): BotGroupTranscript | null {
  if (!current) {
    return action.kind === 'recent' ? action.page : current
  }
  if (action.kind === 'sent') {
    return { ...current, messages: upsert(current.messages, [action.message]) }
  }
  const group = action.kind === 'group' ? action.group : action.page.group
  const accepted = acceptance(current, group)
  if (accepted === 'stale') {
    return current
  }
  switch (action.kind) {
    case 'recent': {
      const { updatedPosts, deferredPostIds: _deferredPostIds, ...page } = action.page
      // Older pages stay only while they still join the new page and no member left, since leaving rewrites their turns.
      const joins =
        page.messages.length === 0 ||
        current.messages.some((message) => message.id === page.messages[0].id)
      return accepted === 'same' && joins
        ? {
            ...current,
            group,
            messages: upsert(current.messages, page.messages, updatedPosts)
          }
        : page
    }
    case 'earlier':
      return accepted === 'same'
        ? {
            ...current,
            hasEarlier: action.page.hasEarlier,
            messages: upsert(current.messages, action.page.messages)
          }
        : current
    case 'updated':
      return accepted === 'same' && action.page.updatedPosts?.length
        ? { ...current, messages: upsert(current.messages, [], action.page.updatedPosts) }
        : current
    case 'group':
      // A member change waits for the next read, which brings the rows that change rewrote.
      return accepted === 'same' ? { ...current, group } : current
  }
}
