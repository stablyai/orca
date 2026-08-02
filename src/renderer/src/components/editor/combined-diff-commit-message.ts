export function getCombinedDiffCommitMessageBody(
  message: string | undefined,
  subject: string | undefined
): string {
  const rawMessage = message ?? ''
  const trimBounds = findTrimBounds(rawMessage, 0, rawMessage.length)
  if (trimBounds.start >= trimBounds.end) {
    return ''
  }

  const firstLineEnd = findCombinedDiffCommitFirstLineEnd(rawMessage, trimBounds)
  const firstLine = rawMessage.slice(trimBounds.start, firstLineEnd)
  if (subject && firstLine.trim() === subject.trim()) {
    const bodyStart = findCombinedDiffCommitNextLineStart(rawMessage, firstLineEnd, trimBounds.end)
    const bodyBounds = findTrimBounds(rawMessage, bodyStart, trimBounds.end)
    return normalizeCombinedDiffCommitMessageSlice(rawMessage, bodyBounds)
  }
  return normalizeCombinedDiffCommitMessageSlice(rawMessage, trimBounds)
}

type CombinedDiffCommitMessageBounds = {
  start: number
  end: number
}

const TRIM_WHITESPACE_PATTERN = /\s/

function findTrimBounds(
  message: string,
  start: number,
  end: number
): CombinedDiffCommitMessageBounds {
  let trimStart = start
  let trimEnd = end

  while (trimStart < trimEnd && TRIM_WHITESPACE_PATTERN.test(message.charAt(trimStart))) {
    trimStart += 1
  }
  while (trimEnd > trimStart && TRIM_WHITESPACE_PATTERN.test(message.charAt(trimEnd - 1))) {
    trimEnd -= 1
  }

  return { start: trimStart, end: trimEnd }
}

function normalizeCombinedDiffCommitMessageSlice(
  message: string,
  bounds: CombinedDiffCommitMessageBounds
): string {
  let normalized = ''
  let sliceStart = bounds.start

  // Why: combined-diff commit messages can come from pasted text. Scan CRLF
  // pairs directly instead of normalizing the whole message with a regex pass.
  for (let index = bounds.start; index < bounds.end; index += 1) {
    if (message.charCodeAt(index) !== 13 || message.charCodeAt(index + 1) !== 10) {
      continue
    }
    normalized += `${message.slice(sliceStart, index)}\n`
    index += 1
    sliceStart = index + 1
  }

  if (sliceStart === bounds.start) {
    return message.slice(bounds.start, bounds.end)
  }

  return normalized + message.slice(sliceStart, bounds.end)
}

function findCombinedDiffCommitFirstLineEnd(
  message: string,
  bounds: CombinedDiffCommitMessageBounds
): number {
  for (let index = bounds.start; index < bounds.end; index += 1) {
    const code = message.charCodeAt(index)
    if (code === 10 || code === 13) {
      return index
    }
  }
  return bounds.end
}

function findCombinedDiffCommitNextLineStart(
  message: string,
  lineEnd: number,
  end: number
): number {
  if (lineEnd >= end) {
    return end
  }
  if (message.charCodeAt(lineEnd) === 13 && message.charCodeAt(lineEnd + 1) === 10) {
    return Math.min(lineEnd + 2, end)
  }
  return lineEnd + 1
}
