import {
  rowsBesideStreamedText,
  streamedTextReplacementIndexes,
  noteStreamedTextRevision
} from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import {
  buildNativeChatTranscript,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import {
  nativeChatRowContentMetrics,
  estimateNativeChatRowHeight,
  nativeChatRowHeightWithControlsInFlow
} from '../../viewport/virtualization/native-chat-row-height-estimate'
import { nativeChatResponseControlsStayInFlow } from './native-chat-response-actions-hang'
import { reviseNativeChatGeneratedImageAnswer } from '../../../../../../shared/native-chat/transcript/images/native-chat-generated-image-answers'

/** Text revisions keep turn chrome and slot membership; rebuild only a changed slot's content. */
export function createNativeChatStreamedTranscript() {
  let held: {
    input: NativeChatTranscriptSlotsInput
    output: ReturnType<typeof buildNativeChatTranscript>
    at: Map<string, { slot: number; member?: number }>
  } | null = null
  return (input: NativeChatTranscriptSlotsInput): ReturnType<typeof buildNativeChatTranscript> => {
    const base = rowsBesideStreamedText(input.messages)
    const structural = { ...input, messages: base }
    const same =
      held &&
      Object.entries(structural).every(
        ([key, value]) => held!.input[key as keyof NativeChatTranscriptSlotsInput] === value
      ) &&
      Object.keys(structural).length === Object.keys(held.input).length
    if (!same) {
      const output = buildNativeChatTranscript(structural)
      const at = new Map<string, { slot: number; member?: number }>()
      output.slots.forEach((slot, index) => {
        if (slot.kind !== 'message') {
          return
        }
        at.set(slot.message.id, { slot: index })
        slot.workRun?.forEach((message, member) => at.set(message.id, { slot: index, member }))
      })
      held = { input: structural, output, at }
    }
    const cached = held!
    const indexes = streamedTextReplacementIndexes(base, input.messages) ?? []
    let slots: NativeChatTranscriptSlot[] | null = null
    const changed = new Set<number>()
    for (const index of indexes) {
      const message = reviseNativeChatGeneratedImageAnswer(base[index]!, input.messages[index]!)
      const place = cached.at.get(message.id)
      if (!place) {
        continue
      } // Live reasoning belongs to the activity line.
      const prior = (slots ?? cached.output.slots)[place.slot]!
      if (prior.kind !== 'message') {
        continue
      }
      const workRun = prior.workRun?.slice()
      if (workRun && place.member !== undefined) {
        workRun[place.member] = message
      }
      const next = {
        ...prior,
        ...(prior.message.id === message.id ? { message } : {}),
        ...(workRun ? { workRun } : {})
      }
      if (!workRun && prior.message.id === message.id) {
        next.estimatedHeight = estimateNativeChatRowHeight(
          nativeChatRowContentMetrics(message, input.typography),
          {
            hasReceipt: next.receipt !== undefined,
            hasStatus: next.status !== undefined,
            hasTurnDiff: next.turnDiff !== undefined,
            turnDiffFileCount: next.turnDiff?.files.length,
            openedPullRequestCount: next.openedPullRequests?.length,
            folded: next.folded
          },
          input.typography
        )
        if (nativeChatResponseControlsStayInFlow(next, input.typography)) {
          next.estimatedHeight = nativeChatRowHeightWithControlsInFlow(
            next.estimatedHeight,
            input.typography
          )
        }
      }
      ;(slots ??= cached.output.slots.slice())[place.slot] = next
      changed.add(place.slot)
    }
    if (!slots) {
      return cached.output
    }
    noteStreamedTextRevision(slots, cached.output.slots, changed)
    return { ...cached.output, slots }
  }
}
