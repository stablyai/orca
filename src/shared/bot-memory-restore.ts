import type { BotMemoryLine } from './bot-memory-lines'

function copyKeys(
  entries: readonly BotMemoryLine[],
  positioned: boolean,
  anchorIds: Map<string | null, number>
): string[] {
  let previous: BotMemoryLine | undefined
  let anchor: string | null = null
  return entries.map((entry) => {
    // A run of removed copies can lose its immediate predecessor in just one snapshot.
    if (!positioned || !previous || entry.after !== previous.line) {
      anchor = entry.after
    }
    previous = entry
    const id = anchorIds.get(anchor) ?? anchorIds.size
    anchorIds.set(anchor, id)
    return `${id}:${entry.line}`
  })
}

/** Match occurrences across snapshots while keeping distinct raw lines and anchors. */
export function mergeBotMemoryCopies(
  file: BotMemoryLine[],
  record: BotMemoryLine[],
  positioned = false
): BotMemoryLine[] {
  if (file.length === 0 || record.length === 0) {
    return file.length === 0 ? record : file
  }
  const matchedFile = new Set<number>()
  const matchedRecord = new Map<number, number>()
  const matchCopies = (fileKeys: string[], recordKeys: string[]): void => {
    const slots = new Map<string, number[]>()
    for (let index = fileKeys.length - 1; index >= 0; index -= 1) {
      if (matchedFile.has(index)) {
        continue
      }
      const key = fileKeys[index]
      const matches = slots.get(key)
      if (matches) {
        matches.push(index)
      } else {
        slots.set(key, [index])
      }
    }
    for (const [index, key] of recordKeys.entries()) {
      if (matchedRecord.has(index)) {
        continue
      }
      const match = slots.get(key)?.pop()
      if (match !== undefined) {
        matchedFile.add(match)
        matchedRecord.set(index, match)
      }
    }
  }
  const anchorIds = new Map<string | null, number>()
  matchCopies(copyKeys(file, positioned, anchorIds), copyKeys(record, positioned, anchorIds))
  if (positioned && matchedRecord.size < Math.min(file.length, record.length)) {
    // An unrelated edit can change a copy's anchor: match those after the stable anchors.
    matchCopies(
      file.map(({ line }) => line),
      record.map(({ line }) => line)
    )
  }

  const beforeFile = new Map<number, BotMemoryLine[]>()
  let extra: BotMemoryLine[] = []
  for (const [index, entry] of record.entries()) {
    const match = matchedRecord.get(index)
    if (match === undefined) {
      extra.push(
        entry.position ? { ...entry, position: { ...entry.position, index: null } } : entry
      )
    } else if (positioned && extra.length > 0) {
      beforeFile.set(match, extra)
      extra = []
    }
  }
  const merged: BotMemoryLine[] = []
  for (const [index, entry] of file.entries()) {
    for (const pending of beforeFile.get(index) ?? []) {
      merged.push(pending)
    }
    merged.push(entry)
  }
  return merged.concat(extra)
}

/** Restore into gaps in the surviving file in one pass: each anchor is indexed once and each gap
 *  emitted once. A line goes after the last copy of the line it followed, or at the end when that
 *  line is gone; a positioned copy goes back to its own index when its predecessor is unchanged. */
export function restoreBotMemoryLines(kept: string[], copies: readonly BotMemoryLine[]): string[] {
  const anchors = new Map<string, number>()
  const precedingAnchor = [0]
  let end = 0
  for (const [index, raw] of kept.entries()) {
    if (raw.trim() !== '') {
      end = index + 1
      anchors.set(raw, end)
    }
    precedingAnchor.push(end)
  }

  const gaps = new Map<number, string[]>()
  const fileAnchors = new Map(anchors)
  let fileCount = 0
  let fileFloor = -1
  let previousFile: string | null = null
  let fileEnd = end
  for (const { line, after, position } of copies) {
    const index = position?.index
    let gap: number
    if (index == null) {
      gap = after === null ? 0 : (anchors.get(after) ?? end)
    } else {
      // Record-only copies do not shift or invalidate the file's original positions.
      const originalGap = index - fileCount
      const preceding = precedingAnchor[originalGap]
      const predecessor = fileFloor >= preceding ? previousFile : (kept[preceding - 1] ?? null)
      const anchor = after === null ? 0 : (fileAnchors.get(after) ?? fileEnd)
      gap =
        preceding !== undefined && originalGap >= fileFloor && predecessor === after
          ? originalGap
          : Math.max(anchor, fileFloor)
      fileCount += 1
      fileFloor = gap
      previousFile = line
      fileEnd = Math.max(fileEnd, gap)
      fileAnchors.set(line, Math.max(gap, fileAnchors.get(line) ?? 0))
    }
    const inserted = gaps.get(gap)
    if (inserted) {
      inserted.push(line)
    } else {
      gaps.set(gap, [line])
    }
    end = Math.max(end, gap)
    anchors.set(line, Math.max(gap, anchors.get(line) ?? 0))
  }

  const restored: string[] = []
  for (const [gap, raw] of kept.entries()) {
    for (const line of gaps.get(gap) ?? []) {
      restored.push(line)
    }
    restored.push(raw)
  }
  return restored.concat(gaps.get(kept.length) ?? [])
}
