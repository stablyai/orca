const ORPHAN_SGR_RE = /\[(?:\d{1,3}(?:;\d{1,3})*)?m/g

export function cleanCommandCodePromptCandidate(value: string): string {
  return foldCommandCodePromptWhitespace(value)
}

export function isCommandCodeIdlePromptCandidate(value: string): boolean {
  return equalsCommandCodePromptIgnoringWhitespace(
    value.replace(ORPHAN_SGR_RE, ''),
    'Askyourquestion...'
  )
}

// Why: this runs inside PTY output observation; prompt labels only need
// collapsed display whitespace, not regex normalization on every status frame.
function foldCommandCodePromptWhitespace(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isCommandCodePromptWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += value.charAt(index)
  }
  return normalized
}

function equalsCommandCodePromptIgnoringWhitespace(value: string, expected: string): boolean {
  let expectedIndex = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isCommandCodePromptWhitespace(code)) {
      continue
    }
    if (value.charAt(index) !== expected.charAt(expectedIndex)) {
      return false
    }
    expectedIndex += 1
  }
  return expectedIndex === expected.length
}

function isCommandCodePromptWhitespace(code: number): boolean {
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
