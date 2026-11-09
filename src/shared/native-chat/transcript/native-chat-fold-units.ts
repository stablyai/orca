import type { NativeChatBlock, NativeChatMessage } from '../native-chat-types'
import { foldToolMessages, type NativeChatToolFoldKind } from '../tools/native-chat-tool-fold'
import { orphanRowId, type NativeChatOrphanOrigin } from '../tools/native-chat-folded-tool-results'

/** An assistant row with the tool rows it absorbs, or one standalone row; each surface finishes its own rows. */
export type NativeChatFoldUnit = {
  sources: readonly NativeChatMessage[]
  rows: NativeChatMessage[]
  orphans: readonly NativeChatOrphanOrigin[]
}

export type NativeChatFoldUnitFinish = (rows: NativeChatMessage[]) => NativeChatMessage[]

export function groupNativeChatFoldUnitMembers(
  grouped: readonly NativeChatMessage[],
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>
): NativeChatMessage[][] {
  const members: NativeChatMessage[][] = []
  let active = false
  for (const source of grouped) {
    const kind = kinds.get(source)!
    if (active && (kind === 'tool' || kind === 'sidecar' || kind === 'pass')) {
      members.at(-1)!.push(source)
    } else {
      members.push([source])
      active = source.role === 'assistant' && kind !== 'orphan'
    }
  }
  return members
}

export function buildNativeChatFoldUnit(
  sources: readonly NativeChatMessage[],
  ids: ReadonlySet<string>,
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>,
  before: NativeChatFoldUnit | undefined,
  finish: NativeChatFoldUnitFinish
): NativeChatFoldUnit {
  if (
    before &&
    before.sources.length === sources.length &&
    before.sources.every((source, index) => source === sources[index])
  ) {
    return before
  }
  // A detached result moves blocks out of its run and can drop an emptied head, so those units re-fold.
  const substituted =
    before &&
    !before.rows.some((row) => row.unpairedToolResults) &&
    (substituteProse(before, sources, kinds) ?? substituteTool(before, sources, kinds))
  if (substituted) {
    return { sources, rows: finish(substituted), orphans: before!.orphans }
  }
  const orphans: NativeChatOrphanOrigin[] = []
  const rows = finish(foldToolMessages(sources, ids, kinds, (origin) => orphans.push(origin)))
  return { sources, rows, orphans }
}

export function buildNativeChatFoldUnits(
  grouped: readonly NativeChatMessage[],
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>,
  previous: ReadonlyMap<string, NativeChatFoldUnit>,
  finish: NativeChatFoldUnitFinish,
  ids: ReadonlySet<string> = new Set(grouped.map((row) => row.id))
): NativeChatFoldUnit[] {
  const units = groupNativeChatFoldUnitMembers(grouped, kinds).map((sources) =>
    buildNativeChatFoldUnit(sources, ids, kinds, previous.get(sources[0]!.id), finish)
  )
  if (units.every((unit) => unit.orphans.length === 0)) {
    return units
  }
  const allocated = new Set(ids)
  const occurrences = new Map<string, number>()
  return units.map((unit) => {
    const renamed = new Map<NativeChatMessage, NativeChatMessage>()
    const orphans = unit.orphans.map((origin) => {
      const id = orphanRowId(origin.sourceId, allocated, occurrences)
      allocated.add(id)
      if (id === origin.row.id) {
        return origin
      }
      const row = { ...origin.row, id }
      renamed.set(origin.row, row)
      return { ...origin, row }
    })
    return renamed.size === 0
      ? unit
      : {
          ...unit,
          orphans,
          rows: unit.rows.map((row) => renamed.get(row) ?? row)
        }
  })
}

/** The one source index that differs, or null when none or several do. */
function onlyChangedSource(
  before: NativeChatFoldUnit,
  sources: readonly NativeChatMessage[]
): number | null {
  if (before.sources.length !== sources.length) {
    return null
  }
  let changed: number | null = null
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index] !== before.sources[index]) {
      if (changed !== null) {
        return null
      }
      changed = index
    }
  }
  return changed
}

function substituteProse(
  before: NativeChatFoldUnit,
  sources: readonly NativeChatMessage[],
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>
): NativeChatMessage[] | null {
  if (onlyChangedSource(before, sources) !== 0) {
    return null
  }
  const old = before.sources[0]!,
    next = sources[0]!
  if (
    old.role !== next.role ||
    (next.role !== 'assistant' && next.role !== 'reasoning') ||
    old.unpairedToolResults ||
    next.unpairedToolResults ||
    !old.blocks.every((block) => block.type === 'text' && !block.providerFrame) ||
    !next.blocks.every((block) => block.type === 'text' && !block.providerFrame)
  ) {
    return null
  }
  const target = before.rows.find((row) => row.id === old.id && row.role === old.role)
  if (!target || !old.blocks.every((block, index) => block === target.blocks[index])) {
    return null
  }
  const contribution = sources
    .slice(1)
    .findLast(
      (source) =>
        source.journalPosition && (kinds.get(source) === 'tool' || kinds.get(source) === 'sidecar')
    )
  const replacement: NativeChatMessage = {
    ...next,
    blocks: [...next.blocks, ...target.blocks.slice(old.blocks.length)],
    ...(contribution ? { foldedJournalPosition: contribution.journalPosition } : {})
  }
  return before.rows.map((row) => (row === target ? replacement : row))
}

/** Pairing reads only tool block order, types and call ids. */
function sameToolShape(
  left: readonly NativeChatBlock[],
  right: readonly NativeChatBlock[]
): boolean {
  return (
    left.length === right.length &&
    left.every((block, index) => {
      const other = right[index]
      return (
        (block.type === 'tool-call' || block.type === 'tool-result') &&
        (other?.type === 'tool-call' || other?.type === 'tool-result') &&
        other.type === block.type &&
        other.callId === block.callId
      )
    })
  )
}

/** A streamed tool row in a wide run splices its blocks into the folded row instead of re-folding every call. */
function substituteTool(
  before: NativeChatFoldUnit,
  sources: readonly NativeChatMessage[],
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>
): NativeChatMessage[] | null {
  const changed = onlyChangedSource(before, sources)
  if (!changed || before.orphans.length > 0) {
    return null
  }
  const old = before.sources[changed]!,
    next = sources[changed]!
  if (
    kinds.get(old) !== 'tool' ||
    kinds.get(next) !== 'tool' ||
    !sameToolShape(old.blocks, next.blocks) ||
    old.journalPosition?.sequence !== next.journalPosition?.sequence ||
    old.journalPosition?.index !== next.journalPosition?.index
  ) {
    return null
  }
  const head = before.sources[0]!
  const target = before.rows.find((row) => row.id === head.id && row.role === 'assistant')
  if (!target) {
    return null
  }
  // Fold order: the head's blocks, then each tool member's blocks and each sidecar member's results.
  let offset = head.blocks.length
  for (let index = 1; index < changed; index += 1) {
    const member = before.sources[index]!
    const kind = kinds.get(member)
    offset +=
      kind === 'tool'
        ? member.blocks.length
        : kind === 'sidecar'
          ? member.blocks.filter((block) => block.type === 'tool-result').length
          : 0
  }
  if (!old.blocks.every((block, index) => target.blocks[offset + index] === block)) {
    return null
  }
  const replacement: NativeChatMessage = {
    ...target,
    blocks: [
      ...target.blocks.slice(0, offset),
      ...next.blocks,
      ...target.blocks.slice(offset + old.blocks.length)
    ]
  }
  return before.rows.map((row) => (row === target ? replacement : row))
}
