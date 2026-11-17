// Response controls sit on the left. They may hang into the gap above the person's own bubble, where
// nothing else on the left starts; elsewhere, the transcript's last row included, they keep their height.

import {
  type NativeChatRowTypography,
  nativeChatRowContentMetrics,
  nativeChatRowHeightWithControlsInFlow
} from '../../viewport/virtualization/native-chat-row-height-estimate'
import type {
  NativeChatMessageSlot,
  NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

/** The person's own right-aligned bubble, with nothing of the row drawn on the left above it. */
function slotOpensWithPersonBubble(slot: NativeChatTranscriptSlot): boolean {
  return (
    slot.kind === 'message' &&
    slot.depth === 0 &&
    slot.drawsMessage &&
    slot.receipt === undefined &&
    slot.statusAbove !== true &&
    slot.message.role === 'user' &&
    // Agent-authored input draws a left-aligned sender card instead of a bubble.
    slot.message.from === undefined &&
    !slot.message.blocks.some((block) => block.type === 'text' && block.providerFrame)
  )
}

/** The list moves an unjournaled, unsent message below the transcript and its tail row. */
function slotDrawsAfterTranscript(slot: NativeChatTranscriptSlot): boolean {
  return (
    slot.kind === 'message' &&
    slot.message.unsent === true &&
    slot.message.journalPosition === undefined
  )
}

/** Whether the row draws something after its message: a turn bar, a diff rollup or a PR card. */
function slotDrawsAfterMessage(slot: NativeChatMessageSlot): boolean {
  return (
    (slot.status !== undefined && slot.statusAbove !== true) ||
    slot.turnDiff !== undefined ||
    slot.openedPullRequests !== undefined
  )
}

/** Whether the row draws response controls, as far as its estimate can tell without its words. */
function slotHoldsControls(
  slot: NativeChatMessageSlot,
  typography: NativeChatRowTypography | undefined
): boolean {
  if (slot.receipt !== undefined || slot.activeTurnIsWorking) {
    return false
  }
  // Outside a turn every worded response holds its own, unless the agent's next step follows.
  return (
    slot.endsResponse ??
    (slot.continuesTurn !== true &&
      nativeChatRowContentMetrics(slot.message, typography).textLines > 0)
  )
}

/** Set `actionsHang` on the conversation's own agent rows, and charge the estimate of a row whose
 *  controls stay in flow. Runs after `endsResponse` and `continuesTurn` are known. */
export function markNativeChatResponseActionsHang(
  drawn: readonly NativeChatTranscriptSlot[],
  typography?: NativeChatRowTypography
): void {
  // Newest first, carrying what draws next: a send that never reached the journal draws after the
  // transcript, so it is not what follows the row before it.
  let following: NativeChatTranscriptSlot | undefined
  for (let index = drawn.length - 1; index >= 0; index -= 1) {
    const slot = drawn[index]!
    const next = following
    if (!slotDrawsAfterTranscript(slot)) {
      following = slot
    }
    // A subagent's section keeps its controls inside its border, so they never hang there.
    if (
      slot.kind !== 'message' ||
      slot.depth !== 0 ||
      !slot.drawsMessage ||
      slot.message.role !== 'assistant'
    ) {
      continue
    }
    if (
      !slotDrawsAfterMessage(slot) &&
      // The last row never hangs, so the gap to the composer is the same whatever the turn ends on.
      next !== undefined &&
      slotOpensWithPersonBubble(next)
    ) {
      slot.actionsHang = true
    } else if (slotHoldsControls(slot, typography)) {
      slot.estimatedHeight = nativeChatRowHeightWithControlsInFlow(slot.estimatedHeight, typography)
    }
  }
}
