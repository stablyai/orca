const MAX_FORK_CONTEXT_CHARS = 36_000
const MAX_FORK_CAPTURE_SANITIZE_CHARS = MAX_FORK_CONTEXT_CHARS * 4
const ESCAPE_CODE = 27
const BELL_CODE = 7

export type AgentSessionForkPromptInput = {
  capturedText: string
  sourceLabel?: string | null
  agentLabel?: string | null
}

function trimToContextBudget(value: string): string {
  if (value.length <= MAX_FORK_CONTEXT_CHARS) {
    return value
  }
  // Why: terminal scrollback can be very large; keep the newest turns where
  // the current user intent and latest findings are most likely to live.
  const omitted = value.length - MAX_FORK_CONTEXT_CHARS
  const marker = `\n\n[Earlier terminal output omitted: ${omitted} characters]\n\n`
  return `${marker}${value.slice(-(MAX_FORK_CONTEXT_CHARS - marker.length))}`
}

function getMarkdownFenceForTranscript(value: string): string {
  let longestFence = 0
  let currentFence = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '`') {
      currentFence++
      longestFence = Math.max(longestFence, currentFence)
    } else {
      currentFence = 0
    }
  }
  return '`'.repeat(Math.max(3, longestFence + 1))
}

function tailBoundForkCapture(value: string): string {
  if (value.length <= MAX_FORK_CAPTURE_SANITIZE_CHARS) {
    return value
  }
  // Why: fork prompts keep newest terminal turns. Bound the raw capture before
  // ANSI/OSC cleanup so a huge scrollback cannot run several full-output scans.
  return value.slice(-MAX_FORK_CAPTURE_SANITIZE_CHARS)
}

export function cleanAgentSessionForkTranscript(value: string): string {
  let result = ''
  let newlineRun = 0

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === ESCAPE_CODE) {
      const skippedIndex = findTerminalEscapeEnd(value, index)
      if (skippedIndex !== null) {
        index = skippedIndex
        continue
      }
    }
    if (code === 13 || code === 10) {
      if (code === 13 && value.charCodeAt(index + 1) === 10) {
        index++
      }
      if (newlineRun < 3) {
        result += '\n'
      }
      newlineRun++
      continue
    }
    if (isUnsupportedTranscriptControl(code)) {
      continue
    }
    result += value[index]
    newlineRun = 0
  }

  return result.trim()
}

function findTerminalEscapeEnd(value: string, escapeIndex: number): number | null {
  const nextCode = value.charCodeAt(escapeIndex + 1)
  if (nextCode === 93) {
    return findOscSequenceEnd(value, escapeIndex + 2) ?? escapeIndex + 1
  }
  if (nextCode === 91) {
    return findCsiSequenceEnd(value, escapeIndex + 2)
  }
  if ((nextCode >= 64 && nextCode <= 90) || (nextCode >= 92 && nextCode <= 95) || nextCode === 99) {
    return escapeIndex + 1
  }
  if ('()*+-./'.includes(value[escapeIndex + 1] ?? '') && escapeIndex + 2 < value.length) {
    return escapeIndex + 2
  }
  return null
}

function findOscSequenceEnd(value: string, index: number): number | null {
  for (let cursor = index; cursor < value.length; cursor++) {
    const code = value.charCodeAt(cursor)
    if (code === BELL_CODE) {
      return cursor
    }
    if (code === ESCAPE_CODE && value[cursor + 1] === '\\') {
      return cursor + 1
    }
  }
  return null
}

function findCsiSequenceEnd(value: string, index: number): number | null {
  let cursor = index
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor)
    if (code < 48 || code > 63) {
      break
    }
    cursor++
  }
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor)
    if (code < 32 || code > 47) {
      break
    }
    cursor++
  }
  return cursor < value.length && value.charCodeAt(cursor) >= 64 && value.charCodeAt(cursor) <= 126
    ? cursor
    : null
}

function isUnsupportedTranscriptControl(code: number): boolean {
  return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
}

export function buildAgentSessionForkPrompt({
  capturedText,
  sourceLabel,
  agentLabel
}: AgentSessionForkPromptInput): string | null {
  const transcript = trimToContextBudget(
    cleanAgentSessionForkTranscript(tailBoundForkCapture(capturedText))
  )
  if (!transcript) {
    return null
  }
  const fence = getMarkdownFenceForTranscript(transcript)

  const header = [
    'This is a fork of an existing Orca agent session.',
    '',
    'Use the captured transcript as background context for this new, independent session. Keep file edits and decisions independent from the original terminal unless I explicitly ask you to coordinate with it.',
    '',
    sourceLabel ? `Source: ${sourceLabel}` : null,
    agentLabel ? `Original agent: ${agentLabel}` : null,
    '',
    'Captured terminal transcript:',
    `${fence}text`
  ].filter((line): line is string => line !== null)

  return [
    ...header,
    transcript,
    fence,
    '',
    'Acknowledge that you have the forked context, then wait for my next instruction.'
  ].join('\n')
}
