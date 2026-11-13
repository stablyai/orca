import type { NativeChatPendingSend } from './native-chat-pending-sends'
import { isImageRefBlock } from '../native-chat-types'
import { normalizedNativeChatUserMessageText } from './native-chat-image-transcript-markers'
import {
  nativeChatReceiptWindow,
  canClaimNativeChatReceipt,
  mayUseLegacyNativeChatReceipt,
  type NativeChatReceiptSnapshot,
  type NativeChatReceiptRow,
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
  nativeChatUserMessageContentKey,
  selectPendingIndicesRepresentedByUserRows
} from './native-chat-pending-occurrence'
import {
  nativeChatPendingGluePiece,
  nativeChatPendingGluedRowText
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
  options: { prospective?: boolean; onlyRows?: ReadonlySet<string> } = {}
): NativeChatPendingWitness[] {
  const count = pending.length
  const eligible = pending.map((entry) => canClaimNativeChatReceipt(entry, options.prospective))
  const windows = pending.map((entry) => nativeChatReceiptWindow(entry, snapshot, sessionId))
  const glueWindows = pending.map((entry) =>
    nativeChatReceiptWindow(entry, snapshot, sessionId, true)
  )
  const lastAdvance = windows.map(
    (eligible) =>
      snapshot.rows.findLast((row) => row.message.role !== 'user' && eligible(row))?.index ?? -1
  )
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
      eligible[index] && entry.sourceReceipt?.sessionId === sessionId
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
    if (members.some((index) => pending[index].sourceReceipt?.sessionId === sessionId)) {
      return
    }
    const memberIds = members.map((index) => pending[index].id)
    if (
      dependencies.some(
        (dependency) =>
          dependency.receipt.sessionId === sessionId &&
          dependency.receipt.id === row.message.id &&
          dependency.proof === proof &&
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
            row.index < ((glueMembers?.has(index) ?? glue) ? lastGlueAdvance : lastAdvance)[index]
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
    eligible[index] &&
    (!entry.sourceAgent || (options.prospective && mayUseLegacyNativeChatReceipt(entry)))
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
    if (!entry.sourceAgent) {
      ranks.set(key, Math.max(rank, ranks.get(key) ?? 0))
    }
    const imageCount = entry.sourceAgent ? 0 : (entry.imagePaths?.filter(Boolean).length ?? 0)
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
      if (row.message.role !== 'user' || !windows[index](row)) {
        continue
      }
      if (pathlessImageCount && !normalizedNativeChatUserMessageText(row.message)) {
        const images = row.message.blocks.filter(isImageRefBlock)
        if (images.length === pathlessImageCount && images.every((image) => !image.path)) {
          offer(row, [index], 'legacy')
        }
      }
      if (
        entry.sourceAgent &&
        sourceKeys[index].includes(nativeChatSourceMessageKey(row.message) ?? '')
      ) {
        offer(row, [index], 'source')
      }
      if (
        (!entry.sourceAgent || (options.prospective && mayUseLegacyNativeChatReceipt(entry))) &&
        nativeChatUserMessageContentKey(row.message, entry.imagePaths) ===
          nativeChatPendingContentKey(projected)
      ) {
        occurrence++
        // Qualify in the original stream, before spent ownership is subtracted.
        if (occurrence >= (entry.sourceAgent ? 1 : rank)) {
          if (hasLegacyImages && pending[index].sourceReceipt?.sessionId !== sessionId) {
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
  for (const row of snapshot.rows) {
    if (
      row.message.role !== 'user' ||
      (options.onlyRows && !options.onlyRows.has(row.message.id)) ||
      !legacy.some(({ index }) => glueWindows[index](row))
    ) {
      continue
    }
    const text = nativeChatPendingGluedRowText(row.message)
    if (!text) {
      continue
    }
    for (let residual = 1; residual < 1 << legacy.length; residual++) {
      const remaining = legacy.filter((_, index) => residual & (1 << index))
      const requires = legacy.reduce(
        (mask, member, index) =>
          residual & (1 << index) ? mask : mask | pendingReceiptBit(member.index, count),
        0
      )
      if (hasLegacyImages) {
        const exact = remaining.filter(({ index }) => exactLegacyRows.get(row.index)?.has(index))
        const rest = remaining.filter(({ index }) => !exactLegacyRows.get(row.index)?.has(index))
        if (
          exact.length &&
          rest.length &&
          remaining.some(({ entry }) => entry.imagePaths?.length)
        ) {
          const glued = selectPendingIndicesRepresentedByUserRows(
            rest.map(({ entry }) => entry),
            [
              {
                id: row.message.id,
                text,
                representablePendingIndices: new Set(
                  rest.flatMap(({ index }, at) => (glueWindows[index](row) ? [at] : []))
                )
              }
            ]
          )
          const glueMembers = new Set([...glued].map((at) => rest[at].index))
          const members = remaining.flatMap(({ index }) =>
            exactLegacyRows.get(row.index)?.has(index) || glueMembers.has(index) ? [index] : []
          )
          if (glueMembers.size && members.some((index) => pending[index].imagePaths?.length)) {
            offer(row, members, 'legacy', requires, false, glueMembers)
          }
        }
      }
      const represented = selectPendingIndicesRepresentedByUserRows(
        remaining.map(({ entry }) => entry),
        [
          {
            id: row.message.id,
            text,
            representablePendingIndices: new Set(
              remaining.flatMap(({ index }, at) => (glueWindows[index](row) ? [at] : []))
            )
          }
        ]
      )
      if (!represented.size) {
        continue
      }
      const members = [...represented].map((at) => remaining[at].index)
      offer(row, members, 'legacy', requires, true)
    }
  }
  return [...candidates.values()].flat()
}
