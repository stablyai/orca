// The pane-scoped command/message failure notice: one field on the ownership
// row, written by a send that outlived its composing surface and consumed by
// whichever surface remounts. Split out of omp-rpc-chat-pane-ownership.ts
// because its two race rules -- who wins the single field, and who is allowed
// to clear it -- are the whole subtlety of the feature.

import { translate } from '@/i18n/i18n'
import type { AppState } from '../types'
import type { OmpRpcChatPaneOwnershipSlice } from './omp-rpc-chat-pane-ownership'

/** The exact notice a consumer read, named back when it clears so a newer
 *  unread failure on the same row survives. Identity, not wording: two sends
 *  can fail into identical text with an identical superseded flag, and a clear
 *  that named only those would take the second failure with the first. */
export type OmpRpcChatPaneConsumedFailure = {
  id: number
}

/** Writes the pane-scoped failure notice into the pane's existing ownership
 *  row. A missing row means the pane owner released it for good (pane/tab
 *  close, identity rebind, quit) — recreating one would strand a notice no
 *  surface is left to clear, so a send that outlived its pane reports nothing.
 *  A bare Chat <-> Terminal toggle, the case this notice exists for, never
 *  clears the row.
 *
 *  A row that exists but belongs to a LATER generation is a different case, and
 *  the fix for it is wording rather than silence: the pane rebound and a
 *  replacement session took the key, so the notice must not read as that
 *  session's own refusal — but the send still cost the user a draft (and, for a
 *  plain message, left an optimistic echo whose pane+agent scope carries no
 *  generation at all), and this row is the only surface left to say so.
 *  `describe` therefore names the rebind as the cause instead of the write
 *  being dropped, which would have made the fence indistinguishable from a
 *  silent loss.
 *
 *  The precedence below only settles two DURABLE notices. A composer that is
 *  mounted shows its live failure from local state and never writes here, so
 *  from this function the field looks free — `commandFailureSuperseded` rides
 *  along so the consumer can finish the same ranking against what it is
 *  already showing. */
export function withPaneFailureMessage(
  s: AppState,
  paneKey: string,
  describe: (superseded: boolean) => string,
  expectedGeneration?: number
):
  | Pick<
      OmpRpcChatPaneOwnershipSlice,
      'ompRpcChatOwnershipByPaneKey' | 'ompRpcChatFailureNoticeSequence'
    >
  | AppState {
  const current = s.ompRpcChatOwnershipByPaneKey[paneKey]
  if (!current) {
    return s
  }
  const superseded = expectedGeneration !== undefined && current.generation !== expectedGeneration
  // One field holds the notice, and the two reports race in either order, so
  // precedence has to be explicit: a superseded report yields to a notice the
  // live session is already waiting to show rather than relabelling that
  // session's own failure as somebody else's rebind. A live report still wins
  // the field back, since nothing has read the superseded one yet.
  //
  // It yields only to a LIVE notice, never to another superseded one: two
  // sends from the same replaced session say the same thing about the same
  // rebind, so there is no attribution to protect -- and yielding would leave
  // the second report with no occurrence id, so a consumer's pending clear
  // naming the first would empty the row and report neither failure.
  if (superseded && current.commandFailureMessage && !current.commandFailureSuperseded) {
    return s
  }
  // Every write is a distinct occurrence, so it gets a distinct id: it is what
  // the consumer names back to clear, and what makes an identical repeat a
  // change the consumer can see at all.
  const id = s.ompRpcChatFailureNoticeSequence + 1
  return {
    ompRpcChatFailureNoticeSequence: id,
    ompRpcChatOwnershipByPaneKey: {
      ...s.ompRpcChatOwnershipByPaneKey,
      [paneKey]: {
        ...current,
        commandFailureMessage: describe(superseded),
        commandFailureSuperseded: superseded,
        commandFailureId: id
      }
    }
  }
}

/** Clears the notice only while `consumed` is still the one on the row: a
 *  consumer reads it at render and clears from a passive effect a tick later,
 *  and another in-flight send can report in between. Clearing the row blind
 *  would erase a notice nobody has seen -- and so would matching on the
 *  wording, which two separate failures of the same send path share. */
export function withPaneFailureCleared(
  s: AppState,
  paneKey: string,
  consumed: OmpRpcChatPaneConsumedFailure
): Pick<OmpRpcChatPaneOwnershipSlice, 'ompRpcChatOwnershipByPaneKey'> | AppState {
  const current = s.ompRpcChatOwnershipByPaneKey[paneKey]
  if (!current || current.commandFailureId !== consumed.id) {
    return s
  }
  return {
    ompRpcChatOwnershipByPaneKey: {
      ...s.ompRpcChatOwnershipByPaneKey,
      [paneKey]: {
        ...current,
        commandFailureMessage: null,
        commandFailureSuperseded: false,
        commandFailureId: null
      }
    }
  }
}

export function describeOmpRpcCommandFailure(command: string, superseded: boolean): string {
  return superseded
    ? translate(
        'components.native-chat.composer.ompRpcCommandSendSuperseded',
        `Command ${command} was not sent: the pane's agent session was replaced first.`,
        { command }
      )
    : translate(
        'components.native-chat.composer.ompRpcCommandSendFailed',
        `Command ${command} could not be sent to the agent.`,
        { command }
      )
}

export function describeOmpRpcMessageFailure(superseded: boolean): string {
  return superseded
    ? translate(
        'components.native-chat.composer.ompRpcSendSuperseded',
        "Message was not sent: the pane's agent session was replaced first."
      )
    : translate(
        'components.native-chat.composer.ompRpcSendFailed',
        'Message could not be sent to the agent.'
      )
}
