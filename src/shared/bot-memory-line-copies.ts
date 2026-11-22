// Forget and Undo on MEMORY.md one line at a time: a fact stated twice loses or gets back one line,
// never every line with its words.
import {
  type BotMemoryChange,
  type BotMemoryLine,
  botMemoryLineKey,
  lineKeys,
  splitLines
} from './bot-memory-lines'

/** `text` without the first line stating `fact`, given as its words or as a whole line, and that
 *  line where it stood; another line stating it, however spaced, stays. */
export function dropBotMemoryFact(
  text: string,
  fact: string
): { text: string; dropped: BotMemoryLine | null } {
  const line = `- ${fact.trim().replace(/^[-*]\s+/, '')}`
  const { text: next, made } = applyBotMemoryLines(text, {
    added: [],
    removed: [{ line, after: null }]
  })
  return { text: next, dropped: made.removed[0] ?? null }
}

/**
 * `change` made one line per entry: each removed one takes out the first line not yet taken that
 * states its fact, and each added one goes back after the line it followed, or at the end when that
 * line is gone. With what it did, each removed line as `text` had it.
 */
export function applyBotMemoryLines(
  text: string,
  change: BotMemoryChange
): { text: string; made: BotMemoryChange } {
  const { lines, eol } = splitLines(text)
  // Each fact's lines, in order, and each line's non-blank line above it.
  const copies = new Map<string, number[]>()
  const above: (string | null)[] = []
  let previous: string | null = null
  lineKeys(lines).forEach((key, index) => {
    const same = key === null ? undefined : copies.get(key)
    if (same) {
      same.push(index)
    } else if (key !== null) {
      copies.set(key, [index])
    }
    above.push(previous)
    previous = lines[index].trim() === '' ? previous : lines[index]
  })
  const out = new Set<number>()
  const removed: BotMemoryLine[] = []
  for (const entry of change.removed) {
    const index = copies.get(botMemoryLineKey(entry) ?? '')?.find((at) => !out.has(at))
    if (index !== undefined) {
      out.add(index)
      removed.push({ line: lines[index], after: above[index] })
    }
  }
  const kept = lines.filter((_raw, index) => !out.has(index))
  const added = change.added.filter((entry) => botMemoryLineKey(entry) !== null)
  for (const { line, after } of added) {
    const anchor = after === null ? -1 : kept.lastIndexOf(after)
    const end = kept.findLastIndex((raw) => raw.trim() !== '') + 1
    kept.splice(after === null || anchor !== -1 ? anchor + 1 : end, 0, line)
  }
  return { text: kept.join(eol), made: { added, removed } }
}

/** How many lines of `text` state the fact `key`. */
export function botMemoryFactCount(text: string, key: string | null): number {
  return key === null ? 0 : lineKeys(splitLines(text).lines).filter((at) => at === key).length
}
