// The owner's status call's fields, for the desktop and the phone alike.
import type { BotItemStatus } from './bot-items'

/** What a host without reason-less cancel gets as the reason; it refuses a cancel with none. */
export const BOT_ITEM_CANCEL_FALLBACK_REASON = 'Canceled'

/** `note`: what Waiting waits on, or a cancel's reason. `cancelTakesNoReason`: the host advertises
 *  BOTS_ITEM_CANCEL_NO_REASON_CAPABILITY. */
export function botItemStatusFields(
  status: BotItemStatus,
  note: string | undefined,
  cancelTakesNoReason: boolean
): { status: BotItemStatus; note?: string; reason?: string } {
  if (status === 'waiting') {
    return note ? { status, note } : { status }
  }
  const reason =
    note || (status === 'canceled' && !cancelTakesNoReason ? BOT_ITEM_CANCEL_FALLBACK_REASON : '')
  return reason ? { status, reason } : { status }
}
