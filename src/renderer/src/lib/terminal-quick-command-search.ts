import {
  getTerminalQuickCommandBody,
  isTerminalAgentQuickCommand
} from '../../../shared/terminal-quick-commands'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import type { TerminalQuickCommand } from '../../../shared/types'

type RankedCommand = {
  command: TerminalQuickCommand
  score: number
  index: number
}

const NO_MATCH = Number.POSITIVE_INFINITY
export const TERMINAL_QUICK_COMMAND_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isTerminalQuickCommandSearchQueryTooLarge(
  query: string,
  maxBytes = TERMINAL_QUICK_COMMAND_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function searchTerminalQuickCommands(
  commands: readonly TerminalQuickCommand[],
  rawQuery: string
): TerminalQuickCommand[] {
  if (isTerminalQuickCommandSearchQueryTooLarge(rawQuery)) {
    return []
  }

  const query = normalizeSearchText(rawQuery)
  if (!query) {
    return [...commands]
  }

  const matches: RankedCommand[] = []
  commands.forEach((command, index) => {
    const score = scoreQuickCommand(command, query)
    if (score !== NO_MATCH) {
      matches.push({ command, score, index })
    }
  })

  matches.sort((a, b) => a.score - b.score || a.index - b.index)
  return matches.map((match) => match.command)
}

export function getTerminalQuickCommandPickerValue({
  preferredCommandId,
  filteredCommands,
  rawQuery
}: {
  preferredCommandId: string | null
  filteredCommands: readonly TerminalQuickCommand[]
  rawQuery: string
}): string {
  if (isTerminalQuickCommandSearchQueryTooLarge(rawQuery)) {
    return ''
  }

  const query = normalizeSearchText(rawQuery)
  if (!query) {
    if (
      preferredCommandId &&
      filteredCommands.some((command) => command.id === preferredCommandId)
    ) {
      return preferredCommandId
    }
    return filteredCommands[0]?.id ?? ''
  }
  return filteredCommands[0]?.id ?? ''
}

function scoreQuickCommand(command: TerminalQuickCommand, query: string): number {
  const body = getTerminalQuickCommandBody(command)
  const scores = [scoreCandidate(query, command.label, 0), scoreCandidate(query, body, 400)]
  if (isTerminalAgentQuickCommand(command)) {
    scores.push(scoreCandidate(query, command.agent, 200))
  }
  return Math.min(...scores)
}

function scoreCandidate(query: string, rawCandidate: string, baseScore: number): number {
  const candidate = normalizeSearchText(rawCandidate)
  if (!candidate) {
    return NO_MATCH
  }
  if (candidate === query) {
    return baseScore
  }
  if (candidate.startsWith(query)) {
    return baseScore + 50
  }
  const wordIndex = candidate.indexOf(` ${query}`)
  if (wordIndex >= 0) {
    return baseScore + 100 + wordIndex
  }
  const index = candidate.indexOf(query)
  if (index >= 0) {
    return baseScore + 200 + index
  }
  return NO_MATCH
}

function normalizeSearchText(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isTerminalQuickCommandSearchWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += value.charAt(index).toLowerCase()
  }
  return normalized
}

function isTerminalQuickCommandSearchWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}
