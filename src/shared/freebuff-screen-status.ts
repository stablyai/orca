import {
  offsetTerminalSupport,
  type TerminalSupportQuery
} from './terminal/output/terminal-content-origin'
import { supportedRegexMatches } from './terminal/output/terminal-supported-occurrences'
import type { ParsedAgentStatusPayload } from './agent-status/contracts/agent-status-types'
import { extractLastOscTitle } from './agent-status/title/osc-title-extraction'
import { extractOscTitleScanTail } from './osc-title-scan-tail'
import { advancePartialEscapeTail } from './terminal/protocol/escape/terminal-partial-escape-tail'

export function splitFreebuffScreenUpdates(data: string, pendingEscape: string): string[] {
  const input = pendingEscape + data
  const chunks: string[] = []
  let start = 0
  // oxlint-disable-next-line no-control-regex -- Terminal protocol delimiters contain ESC and BEL.
  for (const match of input.matchAll(/\x1b\[\?2026l/g)) {
    const end = match.index + match[0].length - pendingEscape.length
    if (end > start) {
      chunks.push(data.slice(start, end))
    }
    start = Math.max(start, end)
  }
  if (start < data.length) {
    chunks.push(data.slice(start))
  }
  return chunks
}

function cleanBoxLine(line: string): string {
  return line.replace(/^[\u2502\u2503\s]+|[\u2502\u2503\s]+$/g, '').trim()
}

/** Reads the live composer area, never status words in the conversation above it. */
export function readFreebuffScreenStatus(
  lines: readonly string[],
  alternate: boolean,
  support?: TerminalSupportQuery
): Omit<ParsedAgentStatusPayload, 'prompt' | 'agentType'> | null {
  const text = lines.join('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const matches = (pattern: RegExp, value = text, query = support) =>
    supportedRegexMatches(value, pattern, query).length > 0
  const rowMatches = (row: number, pattern: RegExp) =>
    matches(pattern, lines[row] ?? '', offsetTerminalSupport(support, offsets[row] ?? text.length))
  if (!alternate) {
    if (
      matches(/freebuff found agent files in this repository/) &&
      matches(/Load and run these\? \[y\/N\]/)
    ) {
      return { state: 'blocked', toolInput: 'Trust repository agent files? [y/N]' }
    }
    return null
  }
  if (matches(/Press ENTER to login\.\.\./)) {
    return { state: 'blocked', toolInput: 'Sign in to Freebuff' }
  }
  const footer = lines.findLastIndex((line) => /\/model\s+to change.*Chat:/.test(line))
  if (footer === -1 || !rowMatches(footer, /\/model\s+to change.*Chat:/)) {
    return null
  }
  const dialog = lines.findLastIndex((line) =>
    /[\u256D\u2500].*Some questions for you.*[\u2500\u256E]/.test(line)
  )
  if (
    dialog !== -1 &&
    dialog < footer &&
    rowMatches(dialog, /[\u256D\u2500].*Some questions for you.*[\u2500\u256E]/) &&
    lines
      .slice(dialog, footer)
      .some((_, index) => rowMatches(dialog + index, /\u2191\u2193 navigate/))
  ) {
    const body = lines.slice(dialog + 1, footer).map(cleanBoxLine)
    if (
      support &&
      body.some((line, index) => {
        if (!/^[\u25BC\u25B6\u25B8\u25BE\u25BA\u25CB\u25CF]/.test(line)) {
          return false
        }
        const row = dialog + 1 + index
        const start = lines[row]!.indexOf(line)
        return !support(offsets[row]! + start, offsets[row]! + start + line.length)
      })
    ) {
      return null
    }
    const question = body
      .find((line) => /^[\u25BC\u25B6\u25B8\u25BE\u25BA]/.test(line))
      ?.replace(/^[\u25BC\u25B6\u25B8\u25BE\u25BA]\s*/, '')
    const options = body.flatMap((line) => {
      const match = /^[\u25CB\u25CF]\s+(.+)$/.exec(line)
      return match ? [{ label: match[1], description: '' }] : []
    })
    return {
      state: 'waiting',
      toolName: 'ask_user',
      toolInput: question ?? 'Freebuff is waiting for an answer',
      ...(question
        ? { interactivePrompt: JSON.stringify({ questions: [{ question, options }] }) }
        : {})
    }
  }
  const composerTop = lines.findLastIndex(
    (line, index) => index < footer && /^\s*\u256D\u2500+\u256E\s*$/.test(line)
  )
  if (
    composerTop === -1 ||
    footer - composerTop > 12 ||
    !rowMatches(composerTop, /^\s*\u256D\u2500+\u256E\s*$/)
  ) {
    return null
  }
  const status = lines[composerTop - 1]?.trim() ?? ''
  const statusRow = composerTop - 1
  const statusStart = lines[statusRow]?.indexOf(status) ?? 0
  if (
    status &&
    support &&
    !support(offsets[statusRow]! + statusStart, offsets[statusRow]! + statusStart + status.length)
  ) {
    return null
  }
  if (
    /^(?:thinking|working|connecting|retrying)\.\.\./.test(status) ||
    status.startsWith('high demand — in line')
  ) {
    return { state: 'working' }
  }
  if (status === '' && matches(/Your first message starts the session\./)) {
    return { state: 'done', sessionBoundary: true }
  }
  if (/^(?:\d+[hms]\s*)+left\b|^unlimited\b/.test(status) && /End session/.test(status)) {
    return { state: 'done' }
  }
  return null
}

/** One observation stream per execution-host terminal; recreated with its screen model. */
export class FreebuffScreenStatusTracker {
  private titleTail = ''
  private frameTail = ''
  private insideFrame = false
  private identified: boolean
  private prompt = ''
  private previous: string | null = null
  private worked = false

  constructor(identified = false) {
    this.identified = identified
  }

  observe(
    data: string,
    readScreen: () => {
      lines: readonly string[]
      alternate: boolean
      support?: TerminalSupportQuery
    }
  ): ParsedAgentStatusPayload | null {
    const titleInput = this.titleTail + data
    this.titleTail = extractOscTitleScanTail(titleInput)
    const title = extractLastOscTitle(titleInput)
    if (title?.startsWith('Freebuff: ')) {
      this.identified = true
      this.prompt = title.slice('Freebuff: '.length)
    }
    const frameInput = this.frameTail + data
    // oxlint-disable-next-line no-control-regex -- Terminal protocol delimiters contain ESC and BEL.
    for (const match of frameInput.matchAll(/\x1b\[\?2026([hl])/g)) {
      this.insideFrame = match[1] === 'h'
    }
    this.frameTail = advancePartialEscapeTail(this.frameTail, data)
    if (!this.identified || this.insideFrame || this.frameTail.length > 0) {
      return null
    }
    const { lines, alternate, support } = readScreen()
    const result = readFreebuffScreenStatus(lines, alternate, support)
    if (!result) {
      return null
    }
    if (result.sessionBoundary) {
      this.prompt = ''
      this.worked = false
    }
    const payload: ParsedAgentStatusPayload = {
      ...result,
      agentType: 'freebuff',
      prompt: this.prompt,
      ...(result.state === 'done' && !this.worked ? { sessionBoundary: true } : {})
    }
    if (result.state === 'working' || result.state === 'waiting') {
      this.worked = true
    }
    const signature = JSON.stringify(payload)
    if (signature === this.previous) {
      return null
    }
    this.previous = signature
    return payload
  }
}
