import type { ParsedAgentStatusPayload } from './agent-status-types'
import { extractLastOscTitle } from './osc-title-extraction'
import { extractOscTitleScanTail } from './osc-title-scan-tail'
import { advancePartialEscapeTail } from './terminal-partial-escape-tail'

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
  return line.replace(/^[│┃\s]+|[│┃\s]+$/g, '').trim()
}

/** Reads the live composer area, never status words in the conversation above it. */
export function readFreebuffScreenStatus(
  lines: readonly string[],
  alternate: boolean
): Omit<ParsedAgentStatusPayload, 'prompt' | 'agentType'> | null {
  const text = lines.join('\n')
  if (!alternate) {
    if (
      /freebuff found agent files in this repository/.test(text) &&
      /Load and run these\? \[y\/N\]/.test(text)
    ) {
      return { state: 'blocked', toolInput: 'Trust repository agent files? [y/N]' }
    }
    return null
  }
  if (/Press ENTER to login\.\.\./.test(text)) {
    return { state: 'blocked', toolInput: 'Sign in to Freebuff' }
  }
  const footer = lines.findLastIndex((line) => /\/model\s+to change.*Chat:/.test(line))
  if (footer === -1) {
    return null
  }
  const dialog = lines.findLastIndex((line) => /[╭─].*Some questions for you.*[─╮]/.test(line))
  if (
    dialog !== -1 &&
    dialog < footer &&
    /↑↓ navigate/.test(lines.slice(dialog, footer).join('\n'))
  ) {
    const body = lines.slice(dialog + 1, footer).map(cleanBoxLine)
    const question = body.find((line) => /^[▼▶▸▾►]/.test(line))?.replace(/^[▼▶▸▾►]\s*/, '')
    const options = body.flatMap((line) => {
      const match = /^[○●]\s+(.+)$/.exec(line)
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
    (line, index) => index < footer && /^\s*╭─+╮\s*$/.test(line)
  )
  if (composerTop === -1 || footer - composerTop > 12) {
    return null
  }
  const status = lines[composerTop - 1]?.trim() ?? ''
  if (
    /^(?:thinking|working|connecting|retrying)\.\.\./.test(status) ||
    status.startsWith('high demand — in line')
  ) {
    return { state: 'working' }
  }
  if (status === '' && text.includes('Your first message starts the session.')) {
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
    readScreen: () => { lines: readonly string[]; alternate: boolean }
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
    const { lines, alternate } = readScreen()
    const result = readFreebuffScreenStatus(lines, alternate)
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
