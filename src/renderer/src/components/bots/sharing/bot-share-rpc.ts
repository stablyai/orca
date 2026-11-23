// The owner's share calls: about a bot on its host; links and reviews on the computer named.
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { botHostTarget, callBotRpc, ownBotHost, type BotRef } from '@/lib/bot-hosts'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  BOT_SHARE_ERRORS,
  type BotShareErrorCode
} from '../../../../../shared/bots/bot-share-errors'
import { botShareErrorCode, botShareErrorMessage } from './bot-share-error-copy'
import type {
  BotShareCandidateSummary,
  BotSharePartFile
} from '../../../../../shared/bots/bot-package'
import type { BotOwnedShare } from '../../../../../shared/bots/bot-share-status'
import type { BotSharePicks } from '../../../../../shared/bots/bot-share-picks'
import type { BotShareOutsidePick } from '../../../../../shared/bots/bot-share-skill-picks'
import type { BotShareReview } from '../../../../../shared/bots/bot-share-received'
import type { SkillCloudOperation } from '../../../../../shared/skills/sharing/skill-cloud-contract'

/** What the owner ticked; an absent list shares all of that part, except memory (off unless named). */
export type BotShareSelection = {
  skills?: string[]
  /** The owner's ticks on skills linked into a project from outside it. */
  outsideSkills?: BotShareOutsidePick[]
  tools?: string[]
  schedules?: string[]
  eventSuggestions?: string[]
  memory?: string[]
}

export type BotSharePublished = {
  share: { id: string; url: string; pinnedVersionId: string }
  version: { versionId: string; packageDigest: string }
}

/** The value of an ok operation; a refused one throws its share code. */
async function value<T>(operation: Promise<SkillCloudOperation<T>>): Promise<T> {
  const result = await operation
  if (result.status !== 'ok') {
    throw new Error(
      result.status === 'reconnect-required' ? BOT_SHARE_ERRORS.reconnect : BOT_SHARE_ERRORS.signIn
    )
  }
  return result.value
}

/** A built candidate; with `last`, the picks and note the bot was last published with, when its
 *  host remembers them (an older host never does). */
export function prepareBotShare(
  bot: BotRef,
  selection: BotShareSelection,
  options: { setupNote?: string; last?: boolean; localOnly?: boolean } = {}
): Promise<{ candidate: BotShareCandidateSummary; last?: BotSharePicks }> {
  return callBotRpc(bot, 'bots.share.prepare', { botId: bot.id, ...selection, ...options })
}

export async function viewBotSharePart(
  bot: BotRef,
  candidateId: string,
  part: string
): Promise<BotSharePartFile[]> {
  const result = await callBotRpc<{ files: BotSharePartFile[] }>(bot, 'bots.share.view', {
    botId: bot.id,
    candidateId,
    part
  })
  return result.files
}

export function publishBotShare(
  bot: BotRef,
  candidateId: string,
  setupNote: string
): Promise<BotSharePublished> {
  return value(
    callBotRpc<SkillCloudOperation<BotSharePublished>>(bot, 'bots.share.publish', {
      botId: bot.id,
      candidateId,
      setupNote
    })
  )
}

export function updateBotShare(
  bot: BotRef,
  candidateId: string,
  setupNote: string,
  link: { shareId: string; expectedVersionId: string }
): Promise<BotSharePublished> {
  return value(
    callBotRpc<SkillCloudOperation<BotSharePublished>>(bot, 'bots.share.publish', {
      botId: bot.id,
      candidateId,
      setupNote,
      link
    })
  )
}

/** Stops a link; with `botId`, this computer forgets that bot's last published picks too. */
export function stopBotShare(shareId: string, botId?: string): Promise<boolean> {
  return value(
    callRuntimeRpc<SkillCloudOperation<boolean>>(ownBotHost().target, 'bots.share.stop', {
      shareId,
      ...(botId ? { botId } : {})
    })
  )
}

/** Every live bot link the owner has, read from Orca Cloud; with `botId`, that bot's link also
 *  carries its version's publish time and digest. */
export function listBotShares(botId?: string): Promise<BotOwnedShare[]> {
  return value(
    callRuntimeRpc<SkillCloudOperation<BotOwnedShare[]>>(
      ownBotHost().target,
      'bots.share.status',
      botId ? { botId } : {}
    )
  )
}

/** A call's value or its message, so a component reads the outcome without try/finally. */
export async function settleBotShare<T>(
  call: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: string; code: BotShareErrorCode | null }> {
  try {
    return { ok: true, value: await call }
  } catch (cause) {
    return { ok: false, error: botShareErrorMessage(cause), code: botShareErrorCode(cause) }
  }
}

/** A received link's review: the version it serves now, or exactly `versionId` (a copy's original).
 *  Null when the link was stopped or has moved past `versionId`. Create takes the review from the
 *  host it reads on, so a bot made on a server reads the link there. */
export async function reviewBotShare(
  shareId: string,
  versionId?: string,
  hostId: ExecutionHostId = ownBotHost().hostId
): Promise<BotShareReview | null> {
  const result = await callRuntimeRpc<{ review: BotShareReview | null }>(
    botHostTarget(hostId),
    'bots.share.review',
    { shareId, versionId }
  )
  return result.review
}
