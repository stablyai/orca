/**
 * Finding the real entrypoint inside an interpreter command line.
 *
 * Split out of `agent-process-recognition.ts`: recognizing WHICH agent a process is is a
 * separate concern from parsing a `node …/cli.js` / `python -m pkg` argv down to the token
 * that names it. Only the latter lives here.
 */

const PROCESS_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i

const STATIC_INTERPRETER_PROCESS_NAMES = new Set([
  'node',
  'python',
  'python3',
  'bash',
  'zsh',
  'sh',
  'fish',
  'pwsh',
  'powershell'
])

export const PYTHON_PROCESS_RE = /^python(?:\d+(?:\.\d+)*)?$/

const INTERPRETER_OPTIONS_WITH_VALUE = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader'
])
const INTERPRETER_OPTIONS_WITH_INLINE_SOURCE = new Set(['-e', '--eval', '-p', '--print', '--check'])

export function isInterpreterProcessName(normalized: string): boolean {
  return STATIC_INTERPRETER_PROCESS_NAMES.has(normalized) || PYTHON_PROCESS_RE.test(normalized)
}

export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      const next = commandLine[index + 1]
      if (next && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
        escaped = true
        continue
      }
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char
      continue
    }
    if (quote === char) {
      quote = null
      continue
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

function tokenLooksExecutable(token: string, index: number, firstNormalized: string): boolean {
  if (index === 0) {
    return true
  }
  if (!isInterpreterProcessName(firstNormalized)) {
    return false
  }
  // Why: only inspect interpreter script paths. Prompt text can mention other
  // agents ("compare opencode vs orca"), and treating every argv token as an
  // executable would reintroduce the substring-style false identity class that
  // foreground-process detection is meant to avoid.
  return token.includes('/') || token.includes('\\') || PROCESS_EXTENSION_RE.test(token)
}

export function findInterpreterEntrypointToken(
  tokens: string[],
  firstNormalized: string
): string | null {
  if (!isInterpreterProcessName(firstNormalized)) {
    return null
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      continue
    }
    if (PYTHON_PROCESS_RE.test(firstNormalized) && token === '-m') {
      return tokens[index + 1] ?? null
    }
    if (token.startsWith('-')) {
      const name = token.split('=', 1)[0] ?? ''
      if (INTERPRETER_OPTIONS_WITH_INLINE_SOURCE.has(name)) {
        return null
      }
      if (INTERPRETER_OPTIONS_WITH_VALUE.has(name) && name === token) {
        index += 1
      }
      continue
    }
    if (tokenLooksExecutable(token, index, firstNormalized)) {
      return token
    }
  }
  return null
}

export function comparablePath(token: string): string {
  return token
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}
