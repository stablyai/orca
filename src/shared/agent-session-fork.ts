const ESC = String.fromCharCode(27)
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_SEQUENCE_PATTERN = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g')
const SINGLE_ESCAPE_PATTERN = new RegExp(`${ESC}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`, 'g')
const MAX_FORK_CONTEXT_CHARS = 36_000

export type AgentSessionForkPromptInput = {
  capturedText: string
  sourceLabel?: string | null
  agentLabel?: string | null
}

export type AgentSessionForkPoint = {
  kind: 'message'
  id: string
}

export type AgentSessionForkPromptInteraction = {
  id: string
  prompt: string
  observedAt?: number
}

export type AgentSessionMessageForkPromptInput = {
  forkPoint: AgentSessionForkPoint
  interactions: AgentSessionForkPromptInteraction[]
  sourceLabel?: string | null
  agentLabel?: string | null
}

export type AgentSessionStructuredHistoryForkPromptInput = {
  interactions: AgentSessionForkPromptInteraction[]
  sourceLabel?: string | null
  agentLabel?: string | null
}

export function normalizeAgentSessionForkPoint(value: unknown): AgentSessionForkPoint | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record.kind !== 'message' || typeof record.id !== 'string') {
    return undefined
  }
  const id = record.id
    .trim()
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .slice(0, 256)
  return id.length > 0 ? { kind: 'message', id } : undefined
}

function trimToContextBudget(value: string): string {
  if (value.length <= MAX_FORK_CONTEXT_CHARS) {
    return value
  }
  // Why: terminal scrollback can be very large; keep the newest turns where
  // the current user intent and latest findings are most likely to live.
  const omitted = value.length - MAX_FORK_CONTEXT_CHARS
  const marker = `\n\n[Earlier terminal output omitted: ${omitted} characters]\n\n`
  return marker + value.slice(-(MAX_FORK_CONTEXT_CHARS - marker.length))
}

function getMarkdownFenceForTranscript(value: string): string {
  const tickPattern = new RegExp(`${String.fromCharCode(96)}+`, 'g')
  const longestFence = Math.max(
    0,
    ...Array.from(value.matchAll(tickPattern), (match) => match[0].length)
  )
  return String.fromCharCode(96).repeat(Math.max(3, longestFence + 1))
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

export function buildAgentSessionMessageForkPrompt({
  forkPoint,
  interactions,
  sourceLabel,
  agentLabel
}: AgentSessionMessageForkPromptInput): string | null {
  const forkIndex = interactions.findIndex((interaction) => interaction.id === forkPoint.id)
  if (forkIndex === -1) {
    return null
  }
  const included = interactions.slice(0, forkIndex + 1)
  if (included.length === 0) {
    return null
  }
  const structuredHistory = included
    .map((interaction, index) => {
      const prompt = interaction.prompt.trim() || '(prompt text unavailable)'
      const observedAt =
        typeof interaction.observedAt === 'number'
          ? ` at ${new Date(interaction.observedAt).toISOString()}`
          : ''
      return `${index + 1}. [${interaction.id}]${observedAt}\n${prompt}`
    })
    .join('\n\n')

  const header = [
    'This is a message-level fork of an existing Orca agent session.',
    '',
    'Use the structured prompt history below as background context for this new, independent session. The history ends at the selected fork point and intentionally excludes later prompts and raw terminal output because terminal scrollback cannot be safely aligned to message IDs.',
    '',
    sourceLabel ? `Source: ${sourceLabel}` : null,
    agentLabel ? `Original agent: ${agentLabel}` : null,
    `Fork point: ${forkPoint.id}`,
    '',
    'Structured prompt history through the fork point:'
  ].filter((line): line is string => line !== null)

  return [
    ...header,
    structuredHistory,
    '',
    'Acknowledge that you have the forked context through the selected message, then wait for my next instruction.'
  ].join('\n')
}

export function buildAgentSessionStructuredHistoryForkPrompt({
  interactions,
  sourceLabel,
  agentLabel
}: AgentSessionStructuredHistoryForkPromptInput): string | null {
  if (interactions.length === 0) {
    return null
  }
  const structuredHistory = trimToContextBudget(
    interactions
      .map((interaction, index) => {
        const prompt = interaction.prompt.trim() || '(prompt text unavailable)'
        const observedAt =
          typeof interaction.observedAt === 'number'
            ? ` at ${new Date(interaction.observedAt).toISOString()}`
            : ''
        return `${index + 1}. [${interaction.id}]${observedAt}\n${prompt}`
      })
      .join('\n\n')
  )

  const header = [
    'This is a fork of an existing Orca agent session.',
    '',
    'Use the structured prompt history below as background context for this new, independent session. The original provider CLI does not expose a native fork command for this session, so Orca is reconstructing the fork context from prompts it recorded.',
    '',
    sourceLabel ? `Source: ${sourceLabel}` : null,
    agentLabel ? `Original agent: ${agentLabel}` : null,
    '',
    'Structured prompt history:'
  ].filter((line): line is string => line !== null)

  return [
    ...header,
    structuredHistory,
    '',
    'Acknowledge that you have the forked context, then wait for my next instruction.'
  ].join('\n')
}
