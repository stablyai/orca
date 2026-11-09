// Parses pasted .env text into one entry per variable, each validated against the secret rules, so the
// preview can show what will be saved before anything leaves the desktop.
import { cloudSecretKind, cloudSecretNameError, cloudSecretValueError } from './cloud-secret-rules'
import type { CloudSecretKind, CloudSecretsErrorCode } from './cloud-secrets-wire'

export type DotenvPasteIssue =
  | CloudSecretsErrorCode
  | 'syntax'
  | 'unterminated_quote'
  | 'overridden'

export type DotenvPasteEntry = {
  /** 1-based line where the entry starts. */
  line: number
  /** Empty when the line could not be read as NAME=value. */
  name: string
  value: string
  kind: CloudSecretKind
  issue: DotenvPasteIssue | null
  /** The source text of the entry (several lines for a multi-line value), to keep it for a retry. */
  raw: string
}

const ASSIGNMENT = /^\s*(?:export\s+)?([^=\s]*)\s*=\s?(.*)$/

function unescapeDoubleQuoted(body: string): string {
  return body.replace(/\\([nrt"\\$])/g, (_match, char: string) =>
    char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char
  )
}

/** Index of the closing quote in `text` from `start`, skipping backslash escapes for double quotes. */
function closingQuote(text: string, start: number, quote: string): number {
  for (let index = start; index < text.length; index++) {
    if (quote === '"' && text[index] === '\\') {
      index++
      continue
    }
    if (text[index] === quote) {
      return index
    }
  }
  return -1
}

export function parseDotenvPaste(text: string): DotenvPasteEntry[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const entries: DotenvPasteEntry[] = []
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const lineNumber = index + 1
    const match = ASSIGNMENT.exec(raw)
    if (!match) {
      entries.push({ line: lineNumber, name: '', value: '', kind: 'env', issue: 'syntax', raw })
      continue
    }
    const name = match[1]
    let rest = match[2].trimStart()
    let value: string
    let issue: DotenvPasteIssue | null = null
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : null
    if (quote) {
      // Quoted values may run over several lines until the matching quote.
      let close = closingQuote(rest, 1, quote)
      while (close === -1 && index + 1 < lines.length) {
        index++
        rest = `${rest}\n${lines[index]}`
        close = closingQuote(rest, 1, quote)
      }
      if (close === -1) {
        // Flag only this line and read on, so one stray quote cannot swallow the rest of the file.
        index = lineNumber - 1
        issue = 'unterminated_quote'
        value = ''
      } else {
        const body = rest.slice(1, close)
        value = quote === '"' ? unescapeDoubleQuoted(body) : body
      }
    } else {
      // Unquoted: an inline comment starts at whitespace followed by #.
      value = rest.startsWith('#') ? '' : rest.replace(/\s+#.*$/, '').trim()
    }
    issue ??= cloudSecretNameError(name) ?? cloudSecretValueError(name, value)
    entries.push({
      line: lineNumber,
      name,
      value,
      kind: cloudSecretKind(name),
      issue,
      raw: lines.slice(lineNumber - 1, index + 1).join('\n')
    })
  }
  // Like a shell sourcing the file, the last assignment of a name wins.
  const lastIndexByName = new Map<string, number>()
  entries.forEach((entry, position) => {
    if (entry.name) {
      lastIndexByName.set(entry.name, position)
    }
  })
  return entries.map((entry, position) =>
    entry.name && lastIndexByName.get(entry.name) !== position && entry.issue === null
      ? { ...entry, issue: 'overridden' }
      : entry
  )
}

/** The NAME -> value map a batch save sends: only clean, final entries. */
export function dotenvPasteToBatch(entries: readonly DotenvPasteEntry[]): Record<string, string> {
  const set: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.issue === null) {
      set[entry.name] = entry.value
    }
  }
  return set
}
