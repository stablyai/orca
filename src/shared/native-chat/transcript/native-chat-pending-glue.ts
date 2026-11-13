import type { NativeChatPendingSend } from './native-chat-pending-sends'
import type { NativeChatReceiptRow } from './native-chat-source-receipts'
import type { NativeChatMessage } from '../native-chat-types'
import type { NativeChatPendingOccurrence } from './native-chat-pending-occurrence'
import { nativeChatContinuationSendText } from './native-chat-continuation-send'
import {
  normalizeNativeChatUserText as normalizeNativeChatPendingText,
  normalizedNativeChatUserMessageText
} from './native-chat-image-transcript-markers'

type PendingPiece = { literal: string; text: string; continuation: boolean }
const pieces = new WeakMap<NativeChatPendingOccurrence, PendingPiece>()
const rowTexts = new WeakMap<NativeChatMessage, string | null>()

export function nativeChatPendingGluePiece(entry: NativeChatPendingOccurrence): PendingPiece {
  const cached = pieces.get(entry)
  if (cached) {
    return cached
  }
  const continuation = nativeChatContinuationSendText(entry.text)
  const literal = normalizeNativeChatPendingText(entry.text)
  const piece = { literal, text: continuation ?? literal, continuation: continuation !== null }
  pieces.set(entry, piece)
  return piece
}

export function nativeChatPendingGluedRowText(message: NativeChatMessage): string | null {
  if (rowTexts.has(message)) {
    return rowTexts.get(message)!
  }
  const text = normalizedNativeChatUserMessageText(message)
  rowTexts.set(message, text)
  return text
}

/** Require the whole row with optional collapsed send-boundary spaces; normalized pieces make greedy matching exact. */
export function countLeadingPendingTextsGluedToUserText(
  pendingTexts: readonly string[],
  userText: string
): number {
  if (pendingTexts.length === 0 || userText.length === 0) {
    return 0
  }
  let cursor = 0
  for (let index = 0; index < pendingTexts.length; index += 1) {
    const piece = pendingTexts[index]
    if (!piece) {
      return 0
    }
    if (userText.startsWith(piece, cursor)) {
      cursor += piece.length
    } else if (index > 0 && userText.startsWith(` ${piece}`, cursor)) {
      cursor += piece.length + 1
    } else {
      return 0
    }
    if (cursor === userText.length) {
      return index + 1
    }
  }
  return 0
}

// Continuations can finish outside this queue, so only their prefix must be represented.
function countLeadingPendingTextsRepresentedByUserText(
  pieces: readonly { text: string; literal: string; continuation: boolean }[],
  userText: string
): number {
  let cursor = 0
  let opened = 0
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]
    if (!piece?.text) {
      return opened
    }
    const at = index > 0 && userText[cursor] === ' ' ? cursor + 1 : cursor
    const literal = piece.continuation && userText.startsWith(piece.literal, at)
    const text = literal ? piece.literal : piece.text
    if (!userText.startsWith(text, at)) {
      return opened
    }
    cursor = at + text.length
    if (
      piece.continuation &&
      !literal &&
      (cursor === userText.length || userText[cursor] === ' ')
    ) {
      opened = index + 1
    }
    if (cursor === userText.length) {
      return index > 0 ? index + 1 : opened
    }
  }
  return opened
}

/** Carry per-send boundaries from the caller; this matcher owns no clock. */
export type NativeChatGluedUserRow = {
  id?: string
  text: string
  /** A row may represent only sends issued before it existed. */
  representablePendingIndices: ReadonlySet<number>
}

/** Match multi-send glue and continuations here; exact single sends retain content-key/occurrence semantics. */
export function selectPendingIndicesRepresentedByUserRows(
  pending: readonly NativeChatPendingOccurrence[],
  rows: readonly NativeChatGluedUserRow[],
  onMatched?: (row: NativeChatGluedUserRow) => void
): Set<number> {
  const represented = new Set<number>()
  const remaining = pending.map((entry, index) => ({ ...nativeChatPendingGluePiece(entry), index }))
  if (rows.length === 0 || (pending.length < 2 && !remaining.some((entry) => entry.continuation))) {
    return represented
  }
  for (const row of rows) {
    const open: typeof remaining = []
    for (const entry of remaining) {
      if (represented.has(entry.index) || entry.text.length === 0) {
        continue
      }
      // A row predating a send ends the adjacent run; skipping it would glue across an invalid boundary.
      if (!row.representablePendingIndices.has(entry.index)) {
        break
      }
      open.push(entry)
    }
    const matched = countLeadingPendingTextsRepresentedByUserText(open, row.text)
    if (matched === 0) {
      continue
    }
    onMatched?.(row)
    for (let i = 0; i < matched; i += 1) {
      const entry = open[i]
      if (!entry) {
        continue
      }
      represented.add(entry.index)
      const at = remaining.findIndex((candidate) => candidate.index === entry.index)
      if (at !== -1) {
        remaining.splice(at, 1)
      }
    }
  }
  return represented
}

export function offerNativeChatGluedWitnesses(
  pending: readonly NativeChatPendingSend[],
  rows: readonly NativeChatReceiptRow[],
  onlyRows: ReadonlySet<string> | undefined,
  legacy: { index: number; entry: NativeChatPendingSend }[],
  glueWindows: ((row: NativeChatReceiptRow) => boolean)[],
  hasLegacyImages: boolean,
  exactLegacyRows: Map<number, Set<number>>,
  count: number,
  pendingReceiptBit: (index: number, count: number) => number,
  offer: (
    row: NativeChatReceiptRow,
    members: number[],
    proof: 'legacy',
    requires?: number,
    glue?: boolean,
    glueMembers?: Set<number>
  ) => void
): void {
  for (const row of rows) {
    if (
      row.message.role !== 'user' ||
      (onlyRows && !onlyRows.has(row.message.id)) ||
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
}
