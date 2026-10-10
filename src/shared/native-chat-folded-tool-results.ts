import { unpairedToolResultIndices } from './native-chat-tool-pairs'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

type ToolContribution = {
  source: NativeChatMessage
  blocks: readonly NativeChatBlock[]
  start: number
  insertAt: number
  sourceRow?: number
}

/** Retains each result's source row while a run combines provider records. */
export class FoldedToolResultSources {
  private readonly contributions = new Map<number, ToolContribution[]>()

  constructor(private readonly sourceMessages: readonly NativeChatMessage[]) {}

  append(
    row: number,
    target: NativeChatMessage,
    source: NativeChatMessage,
    blocks: readonly NativeChatBlock[],
    insertAt: number,
    sourceRow?: number
  ): void {
    let contributors = this.contributions.get(row)
    if (!contributors) {
      contributors = [
        { source: target, blocks: target.blocks, start: 0, insertAt: row + 1, sourceRow: row }
      ]
      this.contributions.set(row, contributors)
    }
    contributors.push({ source, blocks, start: target.blocks.length, insertAt, sourceRow })
  }

  project(rows: NativeChatMessage[]): NativeChatMessage[] {
    let retained: (NativeChatMessage | null)[] | undefined
    const unpairedByRow = new Map<number, ReadonlySet<number>>()
    for (const [rowIndex, message] of rows.entries()) {
      if (
        message.unpairedToolResults ||
        !message.blocks.some((block) => block.type === 'tool-result')
      ) {
        continue
      }
      const unpaired = unpairedToolResultIndices(message.blocks)
      if (unpaired.size === 0) {
        continue
      }
      const blocks = message.blocks.filter((_block, index) => !unpaired.has(index))
      retained ??= Array.from(rows)
      retained[rowIndex] = blocks.length > 0 ? { ...message, blocks } : null
      unpairedByRow.set(rowIndex, unpaired)
    }
    if (!retained) {
      return rows
    }
    const orphans = new Map<number, NativeChatMessage[]>()
    const allocatedIds = new Set(this.sourceMessages.map((message) => message.id))
    const occurrences = new Map<string, number>()
    for (const [rowIndex, unpaired] of unpairedByRow) {
      const message = rows[rowIndex]!
      const contributors = this.contributions.get(rowIndex) ?? [
        {
          source: message,
          blocks: message.blocks,
          start: 0,
          insertAt: rowIndex + 1,
          sourceRow: rowIndex
        }
      ]
      for (const contribution of contributors) {
        const orphanBlocks = contribution.blocks.filter(
          (block, index) =>
            block.type === 'tool-result' &&
            block.callId !== undefined &&
            unpaired.has(contribution.start + index)
        )
        if (orphanBlocks.length === 0) {
          continue
        }
        const sourceStillDraws =
          contribution.sourceRow !== undefined && retained[contribution.sourceRow] !== null
        const id = sourceStillDraws
          ? orphanRowId(contribution.source.id, allocatedIds, occurrences)
          : contribution.source.id
        allocatedIds.add(id)
        const orphan: NativeChatMessage = {
          ...contribution.source,
          id,
          role: 'tool',
          blocks: orphanBlocks,
          unpairedToolResults: true
        }
        const at = orphans.get(contribution.insertAt)
        if (at) {
          at.push(orphan)
        } else {
          orphans.set(contribution.insertAt, [orphan])
        }
      }
    }
    const projected: NativeChatMessage[] = []
    for (let index = 0; index <= retained.length; index += 1) {
      projected.push(...(orphans.get(index) ?? []))
      const message = retained[index]
      if (message) {
        projected.push(message)
      }
    }
    return projected
  }
}

function orphanRowId(
  sourceId: string,
  allocated: ReadonlySet<string>,
  occurrences: Map<string, number>
): string {
  let occurrence = occurrences.get(sourceId) ?? 0
  let id = `unpaired-tool-results:${JSON.stringify([sourceId, occurrence])}`
  while (allocated.has(id)) {
    occurrence += 1
    id = `unpaired-tool-results:${JSON.stringify([sourceId, occurrence])}`
  }
  occurrences.set(sourceId, occurrence + 1)
  return id
}
