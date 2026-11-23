import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import type { Translate } from '@/i18n/use-translate'
import {
  buildNativeChatTranscript,
  type NativeChatMessageSlot,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import { nativeChatMessageSlotHeight } from './native-chat-message-slot-height'
import { nativeChatWorkRunMember } from '../../../../../../shared/native-chat/transcript/folding/native-chat-work-run'
import { NATIVE_CHAT_ACTIVITY_ROW_GAP_PX } from './native-chat-activity-row-joins'
import {
  NATIVE_CHAT_ROW_GAP_PX,
  nativeChatRowHeightWithControlsInFlow
} from '../../viewport/virtualization/native-chat-row-height-estimate'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'

/** Where each row is drawn: a slot's own row or a work run's member by the slot's index; a note
 *  cluster's rows as -1. */
type SlotPlace = { at: number; inRun: boolean }

const slotIndexes = new WeakMap<readonly NativeChatTranscriptSlot[], Map<string, SlotPlace>>()

function slotIndexById(slots: readonly NativeChatTranscriptSlot[]): Map<string, SlotPlace> {
  let index = slotIndexes.get(slots)
  if (!index) {
    index = new Map()
    for (const [at, slot] of slots.entries()) {
      if (slot.kind !== 'message') {
        continue
      }
      // A note cluster draws its members (its head included) from its own list, which a patch can't reach.
      if ((slot.itemNotes?.length ?? 0) > 0) {
        for (const member of [slot.message, ...slot.itemNotes!]) {
          index.set(member.id, { at: -1, inRun: false })
        }
        continue
      }
      index.set(slot.message.id, { at, inRun: slot.workRun !== undefined })
      for (const member of slot.workRun ?? []) {
        index.set(member.id, { at, inRun: true })
      }
    }
    slotIndexes.set(slots, index)
  }
  return index
}

/** A run with `current` in place of `before`, or null when the run's drawing would change: its
 *  height reads only a lead head's text, and a member's lifecycle can regroup the run. */
function withStreamedRunMember(
  slot: NativeChatMessageSlot,
  before: NativeChatMessage,
  current: NativeChatMessage
): NativeChatMessageSlot | null {
  const members = slot.workRun ?? []
  const at = members.indexOf(before)
  const isHead = slot.message === before
  if (at === -1 || before.state !== current.state) {
    return null
  }
  if (isHead && nativeChatWorkRunMember(before, slot.receipt !== undefined, false) === 'lead') {
    return null
  }
  const workRun = members.slice()
  workRun[at] = current
  return { ...slot, workRun, message: isHead ? current : slot.message }
}

/** What a slot draws of its row: a streamed row that keeps these keeps its slot as built. */
function drawnFacts(message: NativeChatMessage): string {
  const content = deriveNativeChatRowContent(message.blocks)
  return [
    message.role,
    content.hasText,
    content.hasImages,
    content.markdown.trim() !== '',
    content.tools.length,
    content.subagentGroups.length,
    content.backgroundTasks.length
  ].join()
}

function sameBesideText(saved: NativeChatMessage, current: NativeChatMessage): boolean {
  return (
    saved.id === current.id &&
    saved.blocks.length === current.blocks.length &&
    saved.blocks.every(
      (block, index) =>
        block === current.blocks[index] ||
        (block.type === 'text' && current.blocks[index]?.type === 'text')
    ) &&
    drawnFacts(saved) === drawnFacts(current)
  )
}

/** The slot's estimate for its current text, as a full build gives it: its own estimate, with its
 *  controls in flow (capped) when they were, less an activity join's pull. Null when the built
 *  estimate can't be told apart that way. */
function streamedSlotHeight(
  slot: NativeChatMessageSlot,
  before: NativeChatMessage,
  current: NativeChatMessage,
  typography: NativeChatTranscriptSlotsInput['typography']
): number | null {
  const pull = slot.followsActivity
    ? (NATIVE_CHAT_ROW_GAP_PX - NATIVE_CHAT_ACTIVITY_ROW_GAP_PX) * (typography?.spacingScale ?? 1)
    : 0
  const own = nativeChatMessageSlotHeight(before, slot, typography)
  const grown = nativeChatMessageSlotHeight(current, slot, typography)
  // Each reading of the built estimate (controls in flow or not) that matches it.
  const readings = [
    { matches: slot.estimatedHeight === own - pull, height: grown - pull },
    {
      matches:
        slot.estimatedHeight === nativeChatRowHeightWithControlsInFlow(own, typography) - pull,
      height: nativeChatRowHeightWithControlsInFlow(grown, typography) - pull
    }
  ].filter((reading) => reading.matches)
  // At the cap both readings match; only one height for the current text is safe to give.
  const heights = new Set(readings.map((reading) => reading.height))
  return heights.size === 1 ? [...heights][0]! : null
}

/**
 * Slots built from `built` with each streaming row's current message in its slot, so a live
 * window rebuilds no transcript structure. Null when a streamed row would draw differently (its
 * first words, an image, a run's lead) or is drawn inside a note cluster, which needs a full build.
 */
export function withStreamedRows(
  slots: NativeChatTranscriptSlot[],
  built: readonly NativeChatMessage[],
  rows: readonly NativeChatMessage[],
  typography?: NativeChatTranscriptSlotsInput['typography']
): NativeChatTranscriptSlot[] | null {
  if (built.length !== rows.length) {
    return null
  }
  let next: NativeChatTranscriptSlot[] | undefined
  for (const [index, current] of rows.entries()) {
    const before = built[index]!
    if (before === current) {
      continue
    }
    if (!sameBesideText(before, current)) {
      return null
    }
    const place = slotIndexById(slots).get(current.id)
    // A row with no slot is not drawn (folded, or the live line's reasoning).
    if (place === undefined) {
      continue
    }
    const { at } = place
    const slot = (next ?? slots)[at]
    if (slot?.kind !== 'message') {
      return null
    }
    if (place.inRun) {
      const run = withStreamedRunMember(slot, before, current)
      if (!run) {
        return null
      }
      next ??= slots.slice()
      next[at] = run
      continue
    }
    if (slot.message !== before) {
      return null
    }
    const estimatedHeight = streamedSlotHeight(slot, before, current, typography)
    if (estimatedHeight === null) {
      return null
    }
    next ??= slots.slice()
    next[at] = { ...slot, message: current, estimatedHeight }
  }
  return next ?? slots
}

type Built = ReturnType<typeof buildNativeChatTranscript>

/** One transcript's slots across live windows: built once from its saved rows, then patched with
 *  each window's streamed rows. A full build its streamed rows needed is kept as the next base,
 *  so later windows patch from it instead of building again. */
export function createNativeChatStreamedTranscript(): (
  input: Omit<NativeChatTranscriptSlotsInput, 'messages'>,
  saved: readonly NativeChatMessage[],
  rows: readonly NativeChatMessage[],
  t?: Translate
) => Built {
  let base: {
    input: Omit<NativeChatTranscriptSlotsInput, 'messages'>
    saved: readonly NativeChatMessage[]
    rows: readonly NativeChatMessage[]
    built: Built
  } | null = null
  return (input, saved, rows, t) => {
    if (!base || base.input !== input || base.saved !== saved) {
      base = {
        input,
        saved,
        rows: saved,
        built: buildNativeChatTranscript({ ...input, messages: saved }, t)
      }
    }
    const slots = withStreamedRows(base.built.slots, base.rows, rows, input.typography)
    if (slots) {
      return { ...base.built, slots }
    }
    base = { input, saved, rows, built: buildNativeChatTranscript({ ...input, messages: rows }, t) }
    return base.built
  }
}
