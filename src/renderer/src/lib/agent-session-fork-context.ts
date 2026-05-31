const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_SEQUENCE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\][^\\u0007]*(?:\\u0007|${String.fromCharCode(27)}\\\\)`,
  'g'
)
const SINGLE_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`,
  'g'
)
const MAX_FORK_CONTEXT_CHARS = 36_000

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
  const longestFence = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length))
  return '`'.repeat(Math.max(3, longestFence + 1))
}

function stripUnsupportedControlCharacters(value: string): string {
  let result = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue
    }
    result += char
  }
  return result
}

export function cleanAgentSessionForkTranscript(value: string): string {
  return stripUnsupportedControlCharacters(
    value
      .replace(OSC_SEQUENCE_PATTERN, '')
      .replace(ANSI_ESCAPE_PATTERN, '')
      .replace(SINGLE_ESCAPE_PATTERN, '')
  )
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

export function buildAgentSessionForkPrompt({
  capturedText,
  sourceLabel,
  agentLabel
}: AgentSessionForkPromptInput): string | null {
  const transcript = trimToContextBudget(cleanAgentSessionForkTranscript(capturedText))
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
