import type { BotMemoryLine } from './bot-memory-lines'

/** The texts, the file's and the record's, that the removed copies were read from. */
export type BotMemorySnapshots = { file: string; record: string }

function copyAnchors(entries: readonly BotMemoryLine[], positioned: boolean): (string | null)[] {
  let previous: BotMemoryLine | undefined
  let anchor: string | null = null
  return entries.map((entry) => {
    // A run of removed copies can lose its immediate predecessor in just one snapshot.
    if (!positioned || !previous || entry.after !== previous.line) {
      anchor = entry.after
    }
    previous = entry
    return anchor
  })
}

/** Match occurrences across snapshots while keeping distinct raw lines and anchors. */
export function mergeBotMemoryCopies(
  file: BotMemoryLine[],
  record: BotMemoryLine[],
  positioned = false,
  snapshots?: BotMemorySnapshots
): BotMemoryLine[] {
  if (file.length === 0 || record.length === 0) {
    return file.length === 0 ? record : file
  }
  const matchedFile = new Set<number>()
  const matchedRecord = new Map<number, number>()
  const matchCopies = (
    fileKeys: string[],
    recordKeys: string[],
    may: (fileIndex: number, recordIndex: number) => boolean = () => true
  ): void => {
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
      const match = slots.get(key)?.at(-1)
      if (!matchedRecord.has(index) && match !== undefined && may(match, index)) {
        slots.get(key)?.pop()
        matchedFile.add(match)
        matchedRecord.set(index, match)
      }
    }
  }
  const fileAnchors = copyAnchors(file, positioned)
  const recordAnchors = copyAnchors(record, positioned)
  const anchorIds = new Map<string | null, number>()
  const keyed = (anchors: (string | null)[], entries: BotMemoryLine[]): string[] =>
    entries.map(({ line }, index) => {
      const id = anchorIds.get(anchors[index]) ?? anchorIds.size
      anchorIds.set(anchors[index], id)
      return `${id}:${line}`
    })
  matchCopies(keyed(fileAnchors, file), keyed(recordAnchors, record))
  if (positioned && matchedRecord.size < Math.min(file.length, record.length)) {
    // An unrelated edit can change a copy's anchor: match those after the stable anchors, unless
    // each copy's anchor is still in the other text, where they are two occurrences.
    const lines = (text: string | undefined): Set<string> | null =>
      text === undefined ? null : new Set(text.split(/\r?\n/))
    const [inFile, inRecord] = [lines(snapshots?.file), lines(snapshots?.record)]
    const kept = (anchor: string | null, text: Set<string> | null): boolean =>
      text !== null && (anchor === null || text.has(anchor))
    matchCopies(
      file.map(({ line }) => line),
      record.map(({ line }) => line),
      (fileIndex, recordIndex) =>
        !kept(fileAnchors[fileIndex], inRecord) || !kept(recordAnchors[recordIndex], inFile)
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
 *  line is gone; a positioned copy goes back to its own index when its predecessor is unchanged.
 *  An unpositioned copy listed between positioned ones stays between them, so neighbors keep their
 *  order whatever became of its anchor. */
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
  const put = (gap: number, line: string): void => {
    const inserted = gaps.get(gap)
    if (inserted) {
      inserted.push(line)
    } else {
      gaps.set(gap, [line])
    }
    end = Math.max(end, gap)
    anchors.set(line, Math.max(gap, anchors.get(line) ?? 0))
  }
  const fileAnchors = new Map(anchors)
  let fileCount = 0
  let fileFloor = -1
  let previousFile: string | null = null
  let fileEnd = end
  // Unpositioned copies since the last positioned one, placed once the next one's gap is known.
  let waiting: BotMemoryLine[] = []
  const placeWaiting = (ceiling: number): void => {
    for (const { line, after } of waiting) {
      const gap = after === null ? 0 : (anchors.get(after) ?? end)
      put(Math.min(Math.max(gap, fileFloor), ceiling), line)
    }
    waiting = []
  }
  for (const copy of copies) {
    const { line, after, position } = copy
    const index = position?.index
    if (index == null) {
      waiting.push(copy)
      continue
    }
    // Record-only copies do not shift or invalidate the file's original positions.
    const originalGap = index - fileCount
    const preceding = precedingAnchor[originalGap]
    const predecessor = fileFloor >= preceding ? previousFile : (kept[preceding - 1] ?? null)
    const anchor = after === null ? 0 : (fileAnchors.get(after) ?? fileEnd)
    const gap =
      preceding !== undefined && originalGap >= fileFloor && predecessor === after
        ? originalGap
        : Math.max(anchor, fileFloor)
    placeWaiting(gap)
    fileCount += 1
    fileFloor = gap
    previousFile = line
    fileEnd = Math.max(fileEnd, gap)
    fileAnchors.set(line, Math.max(gap, fileAnchors.get(line) ?? 0))
    put(gap, line)
  }
  placeWaiting(Number.POSITIVE_INFINITY)

  const restored: string[] = []
  for (const [gap, raw] of kept.entries()) {
    for (const line of gaps.get(gap) ?? []) {
      restored.push(line)
    }
    restored.push(raw)
  }
  return restored.concat(gaps.get(kept.length) ?? [])
}
