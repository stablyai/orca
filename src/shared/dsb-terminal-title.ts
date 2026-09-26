import { containsBrailleSpinner } from './agent-title-core'

// Why: the product name is its own final segment. A Claude task that only
// mentions DeepSeek Build does not end on that segment.
const DSB_TITLE_RE = /(?:^| - )deepseek build$/i

export function isDeepSeekBuildTerminalTitle(title: string): boolean {
  return DSB_TITLE_RE.test(title.trim())
}

function isDsbSpinnerSegment(segment: string): boolean {
  const trimmed = segment.trim()
  return (
    trimmed.length > 0 && /^[\u2800-\u28FF]+$/u.test(trimmed) && containsBrailleSpinner(trimmed)
  )
}

function isDsbActivitySegment(segment: string): boolean {
  const lower = segment.trim().toLowerCase()
  if (
    lower === 'waiting' ||
    lower === 'thinking' ||
    lower === 'responding' ||
    lower === 'compacting' ||
    lower === 'running tool' ||
    lower.includes('action required')
  ) {
    return true
  }
  return (
    lower.startsWith('waiting for ') || lower.startsWith('running:') || lower.startsWith('retrying')
  )
}

/**
 * A busy DeepSeek Build title. The default config puts a braille frame in its
 * own segment while a turn is open; activity words cover the captured
 * "Waiting for response…" form when the spinner is absent.
 */
export function isDsbWorkingTitle(title: string): boolean {
  if (!isDeepSeekBuildTerminalTitle(title)) {
    return false
  }
  return title
    .split(' - ')
    .some((segment) => isDsbSpinnerSegment(segment) || isDsbActivitySegment(segment))
}
