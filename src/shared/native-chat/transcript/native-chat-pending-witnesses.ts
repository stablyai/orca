import type { NativeChatSourceContext } from '../input/native-chat-prompt-observation'
import type { NativeChatPendingSend } from './native-chat-pending-sends'
import { isImageRefBlock } from '../native-chat-types'
import { normalizedNativeChatUserMessageText } from './native-chat-image-transcript-markers'
import {
  nativeChatReceiptWindow,
  canClaimNativeChatReceipt,
  mayUseLegacyNativeChatReceipt,
  type NativeChatReceiptSnapshot,
  type NativeChatReceiptRow,
  nativeChatReceiptIsCurrent,
  liveNativeChatReceiptDependencies
} from './native-chat-source-receipts'
import {
  nativeChatSourceMessageKey,
  nativeChatSourcePendingKeys
} from './native-chat-input-content-key'
import {
  nativeChatPendingContentKey,
  nativeChatPendingMatchKey,
  normalizeNativeChatPendingText,
  nativeChatUserMessageContentKey
} from './native-chat-pending-occurrence'
import {
  nativeChatPendingGluePiece,
  offerNativeChatGluedWitnesses
} from './native-chat-pending-glue'

export type NativeChatPendingWitness = {
  row: NativeChatReceiptRow
  members: number[]
  mask: number
  requires: number
  proof: 'source' | 'legacy'
  glue?: boolean
  glueMembers?: Set<number>
  advanced: Set<string>
}

export function pendingReceiptBit(index: number, count: number): number {
  return 1 << (count - index - 1)
}

/** Existing proof predicates produce alternatives; they never reserve a row before allocation. */
export function nativeChatPendingWitnesses(
  pending: readonly NativeChatPendingSend[],
  snapshot: NativeChatReceiptSnapshot,
  sessionId: string,
  options: {
    prospective?: boolean
    onlyRows?: ReadonlySet<string>
    context?: NativeChatSourceContext
  } = {}
): NativeChatPendingWitness[] {
  const count = pending.length
  const eligible = pending.map((entry) => canClaimNativeChatReceipt(entry, options.prospective))
  const windows = pending.map((entry) => nativeChatReceiptWindow(entry, snapshot, sessionId))
  const sourceWindows = pending.map((entry) =>
    nativeChatReceiptWindow(
      entry,
      snapshot,
      sessionId,
      false,
      true,
      options.context,
      options.prospective
    )
  )
  const glueWindows = pending.map((entry) =>
    nativeChatReceiptWindow(entry, snapshot, sessionId, true)
  )
  const lastAdvance = windows.map(
    (eligible) =>
      snapshot.rows.findLast((row) => row.message.role !== 'user' && eligible(row))?.index ?? -1
  )
  const lastSourceAdvance: (number | undefined)[] = []
  function sourceAdvance(index: number): number {
    return (lastSourceAdvance[index] ??=
      snapshot.rows.findLast((row) => row.message.role !== 'user' && sourceWindows[index](row))
        ?.index ?? -1)
  }
  const lastGlueAdvance = glueWindows.map(
    (eligible) =>
      snapshot.rows.findLast((row) => row.message.role !== 'user' && eligible(row))?.index ?? -1
  )
  const sourceKeys = pending.map((entry) =>
    entry.sourceAgent ? nativeChatSourcePendingKeys(entry) : []
  )
  const dependencies = options.prospective ? [] : liveNativeChatReceiptDependencies(pending)
  const locked = new Map(
    pending.flatMap((entry, index) =>
      eligible[index] && nativeChatReceiptIsCurrent(entry, sessionId, options.context)
        ? [[entry.sourceReceipt.id, index] as const]
        : []
    )
  )
  const candidates = new Map<string, NativeChatPendingWitness[]>()
  const exactLegacyRows = new Map<number, Set<number>>()
  function offer(
    row: NativeChatReceiptRow,
    members: number[],
    proof: 'source' | 'legacy',
    requires = 0,
    glue = false,
    glueMembers?: Set<number>
  ): void {
    if (members.some((index) => !eligible[index])) {
      return
    }
    if (options.onlyRows && !options.onlyRows.has(row.message.id)) {
      return
    }
    if (!options.prospective && locked.has(row.message.id)) {
      return
    }
    if (
      members.some((index) =>
        nativeChatReceiptIsCurrent(pending[index], sessionId, options.context)
      )
    ) {
      return
    }
    const memberIds = members.map((index) => pending[index].id)
    if (
      dependencies.some(
        (dependency) =>
          dependency.receipt.sessionId === sessionId &&
          (dependency.proof !== 'source' ||
            !dependency.receipt.owner ||
            dependency.receipt.owner === options.context?.owner) &&
          dependency.receipt.id === row.message.id &&
          dependency.members.length === memberIds.length &&
          dependency.members.every((id, index) => memberIds[index] === id)
      )
    ) {
      return
    }
    const mask = members.reduce((value, index) => value | pendingReceiptBit(index, count), 0)
    const partition = glueMembers
      ? members
          .map(
            (index) =>
              `${index}:${glueMembers.has(index)}:${row.index < (glueMembers.has(index) ? lastGlueAdvance : lastAdvance)[index]}`
          )
          .join(',')
      : ''
    const signature = `${proof}:${mask}:${requires}:${glue}:${partition}`
    const alternatives = candidates.get(signature) ?? []
    if (alternatives.length >= count) {
      return
    }
    const advanced = new Set(
      members
        .filter(
          (index) =>
            row.index <
            (proof === 'source'
              ? sourceAdvance(index)
              : ((glueMembers?.has(index) ?? glue) ? lastGlueAdvance : lastAdvance)[index])
        )
        .map((index) => pending[index].id)
    )
    alternatives.push({
      row,
      members,
      mask,
      requires,
      proof,
      glue,
      glueMembers,
      advanced
    })
    candidates.set(signature, alternatives)
  }
  const ranks = new Map<string, number>()
  const legacy = pending.flatMap((entry, index) =>
    eligible[index] && mayUseLegacyNativeChatReceipt(entry)
      ? [{ entry: { ...entry, sourceAgent: undefined }, index }]
      : []
  )
  const hasLegacyImages = legacy.some(({ entry }) => entry.imagePaths?.length)
  for (const [index, entry] of pending.entries()) {
    if (!eligible[index]) {
      continue
    }
    const projected = { ...entry, sourceAgent: undefined }
    const key = nativeChatPendingMatchKey(projected)
    const rank = entry.matchingOccurrence ?? (ranks.get(key) ?? 0) + 1
    ranks.set(key, Math.max(rank, ranks.get(key) ?? 0))
    const imageCount = entry.imagePaths?.filter(Boolean).length ?? 0
    const pathlessImageCount =
      imageCount > 0 &&
      entry.delivery === undefined &&
      entry.writeUnconfirmedAt === undefined &&
      (typeof entry.afterMessageId === 'string' || entry.afterEmptyTranscriptSessionId) &&
      !normalizeNativeChatPendingText(entry.text)
        ? imageCount
        : 0
    let occurrence = 0
    for (const row of snapshot.rows) {
      if (row.message.role !== 'user') {
        continue
      }
      if (
        entry.sourceAgent &&
        (!options.onlyRows || options.onlyRows.has(row.message.id)) &&
        sourceWindows[index](row) &&
        row.message.inputContent?.retained &&
        (options.prospective ||
          row.message.inputContent.textDigest === entry.promptSubmission?.textDigest) &&
        sourceKeys[index].includes(nativeChatSourceMessageKey(row.message) ?? '')
      ) {
        offer(row, [index], 'source')
      }
      if (!windows[index](row)) {
        continue
      }
      if (pathlessImageCount && !normalizedNativeChatUserMessageText(row.message)) {
        const images = row.message.blocks.filter(isImageRefBlock)
        if (images.length === pathlessImageCount && images.every((image) => !image.path)) {
          offer(row, [index], 'legacy')
        }
      }
      if (
        mayUseLegacyNativeChatReceipt(entry) &&
        nativeChatUserMessageContentKey(row.message, entry.imagePaths) ===
          nativeChatPendingContentKey(projected)
      ) {
        occurrence++
        // Qualify in the original stream, before spent ownership is subtracted.
        if (occurrence >= rank) {
          if (
            hasLegacyImages &&
            !nativeChatReceiptIsCurrent(pending[index], sessionId, options.context)
          ) {
            const exact = exactLegacyRows.get(row.index) ?? new Set<number>()
            exact.add(index)
            exactLegacyRows.set(row.index, exact)
          }
          offer(row, [index], 'legacy')
        }
      }
    }
  }
  if (
    !legacy.length ||
    (legacy.length === 1 && !nativeChatPendingGluePiece(legacy[0].entry).continuation)
  ) {
    return [...candidates.values()].flat()
  }
  offerNativeChatGluedWitnesses(
    pending,
    snapshot.rows,
    options.onlyRows,
    legacy,
    glueWindows,
    hasLegacyImages,
    exactLegacyRows,
    count,
    pendingReceiptBit,
    offer
  )
  return [...candidates.values()].flat()
}
