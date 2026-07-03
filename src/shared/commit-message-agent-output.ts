/** Strips noise around the agent's output: surrounding whitespace, a single
 *  enclosing fenced code block, and lone "Generating…" preamble lines some
 *  CLIs print before the real answer. */
export function cleanGeneratedCommitMessage(raw: string): string {
  // Why: agent output can include very large generated bodies; normalize and
  // unwrap by scanning boundaries instead of building newline-sized arrays.
  let text = normalizeGeneratedCommitMessageLineFeeds(raw).trim()

  // Why: real commit messages never start with an ellipsis or the word
  // "Generating"/"Thinking" — those leak from CLIs that print a status line
  // before the actual response.
  const firstNewline = text.indexOf('\n')
  if (firstNewline !== -1) {
    const firstLine = text.slice(0, firstNewline)
    if (/^(generating|thinking)\b/i.test(firstLine) || /^[.…]+$/.test(firstLine.trim())) {
      text = text.slice(firstNewline + 1).trim()
    }
  }

  const fenced = findEnclosingCommitMessageFenceBody(text)
  if (fenced !== null) {
    text = fenced.trim()
  }

  // Why: some CLIs format a one-shot answer as a list item even when the
  // prompt asks for raw text; a Git subject should not carry that marker.
  text = text.replace(/^(\s*)(?:[-*•●]\s+|\d+[.)]\s+)/, '$1').trim()

  return text
}

function normalizeGeneratedCommitMessageLineFeeds(value: string): string {
  let crlfStart = value.indexOf('\r\n')
  if (crlfStart === -1) {
    return value
  }

  let normalized = value.slice(0, crlfStart)
  let chunkStart = crlfStart + 2
  normalized += '\n'
  crlfStart = value.indexOf('\r\n', chunkStart)

  while (crlfStart !== -1) {
    normalized += value.slice(chunkStart, crlfStart)
    normalized += '\n'
    chunkStart = crlfStart + 2
    crlfStart = value.indexOf('\r\n', chunkStart)
  }

  return `${normalized}${value.slice(chunkStart)}`
}

function findEnclosingCommitMessageFenceBody(text: string): string | null {
  if (!text.startsWith('```')) {
    return null
  }

  let headerEnd = 3
  while (headerEnd < text.length && text.charCodeAt(headerEnd) !== 10) {
    if (!isCommitFenceInfoCharacter(text.charCodeAt(headerEnd))) {
      return null
    }
    headerEnd++
  }

  if (headerEnd >= text.length) {
    return null
  }

  const closingFenceStart = text.length - 3
  if (closingFenceStart <= headerEnd || !text.endsWith('```')) {
    return null
  }
  if (text.charCodeAt(closingFenceStart - 1) !== 10) {
    return null
  }

  return text.slice(headerEnd + 1, closingFenceStart - 1)
}

function isCommitFenceInfoCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95
  )
}

function stripAnsiControlSequences(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
}

const AGENT_ERROR_CODE_SCAN_LIMIT = 8192
const ERROR_CODE_MARKER = 'error code:'

// Why: agent CLIs (Codex, Claude) prefix their stdout/stderr with config
// preamble, the echoed prompt, and hook lifecycle messages. When something
// fails, the actionable error is buried far below all of that. This pulls
// out the real message so the user sees something legible instead of a
// dump of the agent's runtime state.
export function extractAgentErrorMessage(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`
  // Pass 1: look for an `ERROR:`/`Error:` line carrying a JSON payload.
  // Walk from the end so the most recent (and usually most meaningful)
  // error wins when an agent prints multiple.
  const errorPayload = findLastAgentErrorPayload(combined)
  if (errorPayload !== null) {
    const payload = errorPayload.trim()
    if (payload.startsWith('{')) {
      try {
        const parsed = JSON.parse(payload) as {
          message?: string
          error?: { message?: string }
        }
        const inner = parsed.error?.message ?? parsed.message
        if (typeof inner === 'string' && inner.trim().length > 0) {
          return inner.trim()
        }
      } catch {
        // Fall through to using the raw payload below.
      }
    }
    if (payload.length > 0) {
      return payload
    }
  }

  const compact = extractCompactedErrorCodeTail(combined)
  const errorCodeMatch = compact ? /\bError code:\s*\d+\s*-\s*(.+)$/i.exec(compact) : null
  if (errorCodeMatch) {
    const payload = errorCodeMatch[1].trim()
    const messageMatch = /['"]message['"]\s*:\s*['"]([^'"]+)['"]/i.exec(payload)
    if (messageMatch?.[1]?.trim()) {
      return messageMatch[1].trim()
    }
    if (payload.length > 0) {
      return payload
    }
  }

  return null
}

function extractCompactedErrorCodeTail(combined: string): string | null {
  const markerStart = lastIndexOfAsciiIgnoreCase(combined, ERROR_CODE_MARKER)
  if (markerStart === -1) {
    return null
  }

  return compactAgentErrorTail(
    combined.slice(markerStart, markerStart + AGENT_ERROR_CODE_SCAN_LIMIT)
  )
}

function lastIndexOfAsciiIgnoreCase(value: string, needle: string): number {
  if (needle.length === 0 || value.length < needle.length) {
    return -1
  }
  for (let index = value.length - needle.length; index >= 0; index -= 1) {
    if (equalsAsciiIgnoreCaseAt(value, needle, index)) {
      return index
    }
  }
  return -1
}

function equalsAsciiIgnoreCaseAt(value: string, needle: string, index: number): boolean {
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (
      toAsciiLowerCode(value.charCodeAt(index + offset)) !==
      toAsciiLowerCode(needle.charCodeAt(offset))
    ) {
      return false
    }
  }
  return true
}

function compactAgentErrorTail(value: string): string {
  let compact = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 13 || code === 10) {
      if (code === 13 && value.charCodeAt(index + 1) === 10) {
        index += 1
      }
      const next = findNextNonWhitespaceCode(value, index + 1)
      if (shouldDropWrappedLineBreak(compact.charCodeAt(compact.length - 1), next)) {
        index = next.index - 1
        continue
      }
      if (compact.length > 0 && compact.charCodeAt(compact.length - 1) !== 32) {
        compact += ' '
      }
      index = next.index - 1
      continue
    }
    if (isAsciiWhitespace(code)) {
      if (compact.length > 0 && compact.charCodeAt(compact.length - 1) !== 32) {
        compact += ' '
      }
      continue
    }
    compact += value[index]
  }
  return compact.trim()
}

function findNextNonWhitespaceCode(value: string, start: number): { code: number; index: number } {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (!isAsciiWhitespace(code)) {
      return { code, index }
    }
  }
  return { code: Number.NaN, index: value.length }
}

function shouldDropWrappedLineBreak(previous: number, next: { code: number }): boolean {
  return isAsciiLetter(previous) && (isAsciiLetter(next.code) || next.code === 95)
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32
}

function isAsciiLetter(code: number): boolean {
  const lower = toAsciiLowerCode(code)
  return lower >= 97 && lower <= 122
}

function toAsciiLowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function findLastAgentErrorPayload(combined: string): string | null {
  let lineEnd = combined.length

  for (let index = combined.length - 1; index >= -1; index--) {
    if (index >= 0) {
      const code = combined.charCodeAt(index)
      if (code !== 10 && code !== 13) {
        continue
      }
      if (code === 10 && index > 0 && combined.charCodeAt(index - 1) === 13) {
        continue
      }
    }

    // Why: agent logs can include paste-sized echoed prompts. Error lines are
    // short diagnostics, so bound per-line ANSI stripping before matching.
    const rawLine = combined.slice(
      index + 1,
      Math.min(lineEnd, index + 1 + AGENT_ERROR_CODE_SCAN_LIMIT)
    )
    const line = rawLine.includes(String.fromCharCode(27))
      ? stripAnsiControlSequences(rawLine)
      : rawLine
    const match = /^\s*(?:ERROR|Error(?:\s+during\s+[^:]+)?)\s*:\s*(.+)$/i.exec(line)
    if (match?.[1]) {
      return match[1]
    }
    lineEnd = index > 0 && combined.charCodeAt(index - 1) === 13 ? index - 1 : index
  }

  return null
}
