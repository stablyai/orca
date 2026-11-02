import { PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR } from '../../../../shared/check-job-log-tail-slice'

export type CheckLogDiagnosticAnchor = {
  start: number
  end: number
  nearbyStackStart?: number
  nearbyStackEnd?: number
}

const diagnosticPattern =
  /##\[error\]|::error(?:\s+[^:]*)?::|\b(?:[A-Z][\w.]*Error|Error|error|panic):\s*\S|\berror\s+[A-Z]+\d+:\s*\S|\b(?:ENOENT|EACCES)\b[: ,]+\S/
const genericExitPattern =
  /^(?:(?:error|[\w.]*Error):\s*)?(?:(?:process|command)\s+(?:completed|failed|exited)\s+(?:with\s+)?(?:exit\s+)?code\s+\d+|job failed:\s*exit code\s+\d+|exit code\s+\d+)[.!]?\s*$/i
const genericHeadingPattern =
  /^(?:FAILED|\d+\s+tests?\s+failed|(?:test\s+)?stderr(?:\s*\|.*)?)[.!]?\s*$/i
const framePattern = /^\s*at\s+\S|\S+\.[\w]+:\d+:\d+\b/
const diagnosticPrefixPattern =
  /^\s*(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s+)?$/

export function findInitialCheckLogDiagnostic(text: string): CheckLogDiagnosticAnchor | null {
  const lines: { text: string; start: number; end: number }[] = []
  let start = 0
  for (const line of text.split('\n')) {
    lines.push({ text: line, start, end: start + line.length })
    start += line.length + 1
  }
  const separator = lines.findIndex((line) => line.text === PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
  const segments =
    separator === -1
      ? [[0, lines.length]]
      : [
          [separator + 1, lines.length],
          [0, separator]
        ]
  for (const [from, to] of segments) {
    let inlineFallback: CheckLogDiagnosticAnchor | null = null
    for (let index = from; index < to; index += 1) {
      const line = lines[index]
      if (/^\s*at\s/i.test(line.text)) {
        continue
      }
      const match = diagnosticPattern.exec(line.text)
      if (!match) {
        continue
      }
      const candidate = line.text.slice(match.index)
      const body = candidate.replace(/^(?:##\[error\]|::error(?:\s+[^:]*)?::)\s*/, '').trim()
      if (
        !body ||
        genericExitPattern.test(body) ||
        (genericHeadingPattern.test(body) && !diagnosticPattern.test(body))
      ) {
        continue
      }
      const anchor: CheckLogDiagnosticAnchor = { start: line.start + match.index, end: line.end }
      for (let nearby = index + 1; nearby < Math.min(to, index + 13); nearby += 1) {
        if (diagnosticPattern.test(lines[nearby].text)) {
          break
        }
        if (framePattern.test(lines[nearby].text)) {
          anchor.nearbyStackStart = lines[nearby].start
          anchor.nearbyStackEnd = lines[nearby].end
          break
        }
      }
      // Embedded logger errors are weaker evidence without nearby stack context.
      if (
        !diagnosticPrefixPattern.test(line.text.slice(0, match.index)) &&
        !/^(?:##\[error\]|::error)/.test(candidate) &&
        anchor.nearbyStackStart === undefined
      ) {
        inlineFallback ??= anchor
        continue
      }
      return anchor
    }
    if (inlineFallback) {
      return inlineFallback
    }
  }
  return null
}

export function hasCheckReadingLayout(node: HTMLElement): boolean {
  if (!node.isConnected || node.clientWidth <= 0 || node.clientHeight <= 0) {
    return false
  }
  const rect = node.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

export function measureInitialCheckLogScrollTop(
  pre: HTMLPreElement,
  anchor: CheckLogDiagnosticAnchor
): number | null {
  const text = pre.firstChild
  if (!(text instanceof Text) || !hasCheckReadingLayout(pre)) {
    return null
  }
  const measure = (start: number, end: number): DOMRect[] => {
    if (start < 0 || end > text.length || start >= end) {
      return []
    }
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, end)
    return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
  }
  const diagnostic = measure(anchor.start, anchor.end)[0]
  if (!diagnostic) {
    return null
  }
  const stack =
    anchor.nearbyStackStart !== undefined && anchor.nearbyStackEnd !== undefined
      ? measure(anchor.nearbyStackStart, anchor.nearbyStackEnd).at(-1)
      : undefined
  const rect = pre.getBoundingClientRect()
  const style = getComputedStyle(pre)
  const paddingTop = Number.parseFloat(style.paddingTop) || 0
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0
  const lineHeight = Number.parseFloat(style.lineHeight) || 16
  const diagnosticTop = diagnostic.top - rect.top - pre.clientTop + pre.scrollTop
  const upper = diagnosticTop - paddingTop
  const lower = stack
    ? stack.bottom - rect.top - pre.clientTop + pre.scrollTop + paddingBottom - pre.clientHeight
    : 0
  const preferred = upper - lineHeight
  const target = lower <= upper ? Math.max(lower, preferred) : upper
  return Math.min(Math.max(0, pre.scrollHeight - pre.clientHeight), Math.max(0, target))
}
