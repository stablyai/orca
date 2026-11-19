import { remendWithEdits, type RemendCopyPiece } from 'remend'

export type MarkdownSourceRun = {
  start: number
  end: number
  authoredStart: number | null
}

export type MappedMarkdown = {
  text: string
  runs: readonly MarkdownSourceRun[]
}

export function authoredMarkdown(text: string, start = 0): MappedMarkdown {
  return { text, runs: text ? [{ start: 0, end: text.length, authoredStart: start }] : [] }
}

function appendRun(runs: MarkdownSourceRun[], run: MarkdownSourceRun): void {
  if (run.start === run.end) {
    return
  }
  const previous = runs.at(-1)
  if (
    previous?.end === run.start &&
    (previous.authoredStart === null
      ? run.authoredStart === null
      : run.authoredStart === previous.authoredStart + previous.end - previous.start)
  ) {
    previous.end = run.end
  } else {
    runs.push(run)
  }
}

export function copyMappedMarkdown(
  input: MappedMarkdown,
  pieces: readonly RemendCopyPiece[]
): MappedMarkdown {
  const runs: MarkdownSourceRun[] = []
  const text: string[] = []
  let offset = 0
  let cursor = 0
  let lastCopyEnd = 0
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      text.push(piece)
      appendRun(runs, { start: offset, end: offset + piece.length, authoredStart: null })
      offset += piece.length
      continue
    }
    const [start, end] = piece
    if (start < lastCopyEnd || end < start || end > input.text.length) {
      throw new Error('Non-monotone Markdown source trace')
    }
    lastCopyEnd = end
    text.push(input.text.slice(start, end))
    while (cursor < input.runs.length && input.runs[cursor]!.end <= start) {
      cursor++
    }
    while (cursor < input.runs.length) {
      const run = input.runs[cursor]!
      if (run.start >= end) {
        break
      }
      const from = Math.max(start, run.start)
      const to = Math.min(end, run.end)
      appendRun(runs, {
        start: offset + from - start,
        end: offset + to - start,
        authoredStart: run.authoredStart === null ? null : run.authoredStart + from - run.start
      })
      if (run.end > end) {
        break
      }
      cursor++
    }
    offset += end - start
  }
  return { text: text.join(''), runs }
}

export function authoredMarkdownAnchor(
  input: MappedMarkdown,
  start: number,
  length: number
): number | null {
  if (length <= 0 || start < 0 || start + length > input.text.length) {
    return null
  }
  let low = 0
  let high = input.runs.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (input.runs[middle]!.end <= start) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  const run = input.runs[low]
  if (!run || run.authoredStart === null || run.start > start || run.end < start + length) {
    return null
  }
  return run.authoredStart + start - run.start
}

export function prepareNativeChatMarkdown(
  text: string,
  start: number,
  growing: boolean
): MappedMarkdown {
  let mapped = authoredMarkdown(text, start)
  if (!growing) {
    return mapped
  }
  const repaired = remendWithEdits(
    text,
    { linkMode: 'text-only', katex: false, inlineKatex: false },
    (input, pieces) => {
      if (mapped.text !== input) {
        throw new Error('Markdown repair trace lost its input')
      }
      mapped = copyMappedMarkdown(mapped, pieces)
    }
  )
  if (mapped.text !== repaired) {
    throw new Error('Markdown repair trace lost an output operation')
  }
  return mapped
}
