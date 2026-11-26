// @protected-copy scope=file
// A refused share in one line the owner can act on; an unknown failure keeps the generic line.
import { translate } from '@/i18n/i18n'
import {
  BOT_SHARE_ERRORS,
  type BotShareErrorCode
} from '../../../../../shared/bots/bot-share-errors'
import { botErrorMessage } from '../bot-presentation'

function copyFor(code: BotShareErrorCode): string {
  switch (code) {
    case BOT_SHARE_ERRORS.blocked:
      return translate(
        'bots.share.error.blocked',
        'A secret was found in what would be shared. Remove it, then try again.'
      )
    case BOT_SHARE_ERRORS.noteSecret:
      return translate(
        'bots.share.error.noteSecret',
        'The setup note looks like it holds a secret. Remove it, then try again.'
      )
    case BOT_SHARE_ERRORS.expired:
      return translate(
        'bots.share.error.expired',
        'This share preview expired. Open Share bot again.'
      )
    case BOT_SHARE_ERRORS.prepareAgain:
      return translate(
        'bots.share.error.prepareAgain',
        'This bot was shared from another window meanwhile. Open Share bot again.'
      )
    case BOT_SHARE_ERRORS.stopped:
      return translate(
        'bots.share.error.stopped',
        'This link was stopped. Publish to make a new link.'
      )
    case BOT_SHARE_ERRORS.moved:
      return translate(
        'bots.share.error.moved',
        'This link was updated somewhere else. Open Share bot again to see it.'
      )
    case BOT_SHARE_ERRORS.unavailable:
      return translate('bots.share.error.unavailable', "Orca Cloud doesn't accept bot shares yet.")
    case BOT_SHARE_ERRORS.avatarRefused:
      return translate(
        'bots.share.error.avatarRefused',
        "Orca Cloud refused the bot's picture. Pick another picture, then try again."
      )
    case BOT_SHARE_ERRORS.tooLarge:
      return translate(
        'bots.share.error.tooLarge',
        'This bot is too large to share. Leave out some memory or skills, then try again.'
      )
    case BOT_SHARE_ERRORS.signIn:
      return translate('bots.share.signIn', 'Sign in to Orca to share.')
    case BOT_SHARE_ERRORS.reconnect:
      return translate('bots.share.reconnect', 'Sign in to Orca again to share.')
  }
}

const CODES = Object.values(BOT_SHARE_ERRORS)

/** The share code a failure carries, whichever host or wrapper it came through. */
export function botShareErrorCode(cause: unknown): BotShareErrorCode | null {
  const message = cause instanceof Error ? cause.message : ''
  return CODES.find((code) => message.includes(code)) ?? null
}

export function botShareErrorMessage(cause: unknown): string {
  const code = botShareErrorCode(cause)
  return code ? copyFor(code) : botErrorMessage(cause)
}
