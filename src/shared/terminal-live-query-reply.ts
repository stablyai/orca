import type { PtyOwnerBackend } from './pty-owner-backend'
import {
  shouldInjectQueryReplyForOwnerFromProcessWithToken,
  type ForegroundProcessReader,
  type ForegroundProcessToken,
  type ForegroundProcessTokenReader,
  type TerminalQueryOwnerTracker
} from './terminal-query-owner'
import { needsCookedEchoSafeQueryReply } from './terminal-query-reply'

type ReplyOwner = string | null | undefined

export function routeTerminalLiveQueryReply(
  reply: string,
  ownerBackend: PtyOwnerBackend,
  tracker: TerminalQueryOwnerTracker,
  foregroundReader: ForegroundProcessReader | undefined,
  tokenReader: ForegroundProcessTokenReader | undefined,
  answerCooked: (owner: ReplyOwner, token: ForegroundProcessToken) => boolean,
  answerImmediate: (owner: ReplyOwner, token: ForegroundProcessToken) => boolean
): boolean {
  const claim = tracker.claimReplyOwner(reply)
  if (!claim.matched) {
    return false
  }
  if (
    ownerBackend === 'posix-pty' &&
    !shouldInjectQueryReplyForOwnerFromProcessWithToken(
      claim.owner,
      foregroundReader,
      claim.token,
      tokenReader
    )
  ) {
    return true
  }
  return needsCookedEchoSafeQueryReply(reply)
    ? answerCooked(claim.owner, claim.token)
    : answerImmediate(claim.owner, claim.token)
}
