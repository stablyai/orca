import type { PtyOwnerBackend } from './pty-owner-backend'
import {
  readForegroundProcess,
  shouldInjectQueryReplyForOwner,
  type ForegroundProcessReader,
  type TerminalQueryOwnerTracker
} from './terminal-query-owner'
import { needsCookedEchoSafeQueryReply } from './terminal-query-reply'

type ReplyOwner = string | null | undefined

export function routeTerminalLiveQueryReply(
  reply: string,
  ownerBackend: PtyOwnerBackend,
  tracker: TerminalQueryOwnerTracker,
  foregroundReader: ForegroundProcessReader | undefined,
  answerCooked: (owner: ReplyOwner) => boolean,
  answerImmediate: (owner: ReplyOwner) => boolean
): boolean {
  const claim = tracker.claimReplyOwner(reply)
  if (!claim.matched) {
    return false
  }
  if (
    ownerBackend === 'posix-pty' &&
    !shouldInjectQueryReplyForOwner(claim.owner, readForegroundProcess(foregroundReader))
  ) {
    return true
  }
  return needsCookedEchoSafeQueryReply(reply)
    ? answerCooked(claim.owner)
    : answerImmediate(claim.owner)
}
