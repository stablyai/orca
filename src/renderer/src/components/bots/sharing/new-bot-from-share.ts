// New bot, from a reviewed link: what the regular New bot dialog needs to make the reviewed version.
// Create writes that version whole, or nothing.
import { createBot } from '@/lib/bot-catalog'
import { ownBotHost } from '@/lib/bot-hosts'
import { BOT_NAME_MAX_LENGTH, type Bot } from '../../../../../shared/bot-types'
import type { BotCreateParams } from '../../../../../shared/rpc-contract/bots-params'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  BOT_SHARE_RECEIVE_ERRORS,
  type BotShareReview
} from '../../../../../shared/bots/bot-share-received'
import { reviewBotShare } from './bot-share-rpc'
import type { BotAgentSetup } from '../BotAgentLaunchPicker'
import type { BotPermissionIntent } from '../use-bot-agent-setup'
import type { NewBotPicture } from '../use-new-bot-picture'

const RECEIVE_CODES = ['updated', 'stopped', 'expired'] as const
export type BotShareMoved = (typeof RECEIVE_CODES)[number]

/** A reviewed link, made into a bot by New bot. */
export type NewBotShareSource = {
  review: BotShareReview
  /** The tools the review let it contact. */
  toolIds: string[]
  /** Back to the review. */
  onBack: () => void
  /** The link moved or stopped since the review, or the review expired: back to it. */
  onMoved: (why: BotShareMoved) => void
}

/** The shared name, or "Name 2", "Name 3"… when a bot here has it. */
export function freeBotName(name: string, bots: readonly Pick<Bot, 'name'>[]): string {
  const taken = new Set(bots.map((bot) => bot.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) {
    return name
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${name.slice(0, BOT_NAME_MAX_LENGTH - ` ${n}`.length)} ${n}`
    if (!taken.has(candidate.toLowerCase())) {
      return candidate
    }
  }
}

/** The shared picture, as base64 PNG, when the link has one. */
export function sharedPicturePng(review: BotShareReview): string | undefined {
  return review.avatarDataUrl?.slice(review.avatarDataUrl.indexOf(',') + 1)
}

function sharedMascotAvatar(review: BotShareReview) {
  return review.bot.avatar && 'mascot' in review.bot.avatar ? review.bot.avatar : undefined
}

/** The shared mascot, when the link names one. */
export function sharedMascot(review: BotShareReview): string | undefined {
  return sharedMascotAvatar(review)?.mascot
}

/** The shared mascot's tile color and outfit. */
export function sharedLook(review: BotShareReview): { color?: string; outfit?: string } {
  const avatar = sharedMascotAvatar(review)
  return { color: avatar?.color, outfit: avatar?.outfit }
}

/** What Create writes for the agent: the owner's permission, kept even on an agent that can't offer
 *  it, as Settings keeps it. */
function sharedBotSetup(
  setup: BotAgentSetup,
  intent: BotPermissionIntent | undefined
): BotAgentSetup {
  const { permissionMode: _shown, ...rest } = setup
  return intent && intent !== 'inherit' ? { ...rest, permissionMode: intent } : rest
}

/** Makes the reviewed bot on `hostId`; null once `onMoved` has sent the owner back to the review.
 *  Without `avatar`, Create writes the shared picture itself. */
export async function createBotFromShare(
  source: NewBotShareSource,
  hostId: ExecutionHostId,
  params: BotCreateParams
): Promise<Bot | null> {
  const { review, toolIds, onMoved } = source
  try {
    // The review shown was read here; another computer reads the same version for itself.
    const reviewId =
      hostId === ownBotHost().hostId
        ? review.reviewId
        : (await reviewBotShare(review.shareId, review.versionId, hostId))?.reviewId
    if (!reviewId) {
      onMoved('expired')
      return null
    }
    return await createBot(hostId, {
      ...params,
      // This client sends the look it shows, so the host never fills in the shared one.
      fromShare: { reviewId, toolIds, lookSent: true }
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : ''
    const moved = RECEIVE_CODES.find((code) => message.includes(BOT_SHARE_RECEIVE_ERRORS[code]))
    if (moved) {
      onMoved(moved)
      return null
    }
    throw cause
  }
}

/** New bot's Create for a link: the reviewed bot under the owner's name, agent, permission and
 *  picture. The shared picture is written by Create itself; another upload is saved after, as for any
 *  bot. Null once `onMoved` has sent the owner back to the review. */
export async function createNewBotFromShare(
  source: NewBotShareSource,
  hostId: ExecutionHostId,
  made: { name: string; setup: BotAgentSetup; intent: BotPermissionIntent | undefined },
  picture: NewBotPicture
): Promise<Bot | null> {
  const sharedPng = sharedPicturePng(source.review)
  const keepsShared = sharedPng !== undefined && picture.shownUpload === sharedPng
  const bot = await createBotFromShare(source, hostId, {
    name: made.name,
    ...sharedBotSetup(made.setup, made.intent),
    ...(keepsShared
      ? {}
      : {
          avatar: picture.avatar,
          avatarColor: picture.avatarColor,
          avatarOutfit: picture.avatarOutfit
        })
  })
  return !bot || keepsShared ? bot : picture.saveUpload(bot)
}
