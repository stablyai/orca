// Word boundaries preserve FOO_SECRET matches; consume full Bearer/Token values.
const LABELED_KV =
  /\b(?:api[-_]?key|token|secret|password|bearer|authorization)\b\s*[:=]\s*(?:Bearer\s+\S+|Token\s+\S+|\S+)/gi

// Match specific providers first so sk-ant- retains its Anthropic tag.
const PROVIDER_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'anthropic-key', re: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { tag: 'openai-key', re: /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g },
  { tag: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { tag: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  {
    tag: 'aws-secret-access-key',
    re: /aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi
  },
  {
    tag: 'jwt',
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
  },
  { tag: 'slack-token', re: /xox[baprsoe]-[A-Za-z0-9-]{10,}/g },
  {
    tag: 'pem',
    // Lazy matching keeps adjacent blocks separate; interrupted logs may lack an END marker.
    re: /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g
  }
]

// Strip both user:pass@ and token@ while retaining host/path diagnostics.
const URL_USERINFO = /(https?:\/\/)([^/@\s]+)@/g

// Match whole multiline .env values, including Bearer tails, but skip empty values.
const ENV_LINE = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*\S.*/my
// Match the engine’s non-ASCII whitespace semantics (NBSP, BOM, U+2028…).
const WHITESPACE_RUN = /\s*/y
// Scan regex line terminators without invoking the regex engine for no-match lines.
const LINE_TERMINATORS = ['\n', '\r', '\u2028', '\u2029'] as const

/** Idempotent so sink, bundle and server passes can safely repeat. */
export function redactString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    return input
  }
  let out = input

  out = out.replace(LABELED_KV, '[redacted:labeled-kv]')

  // Redaction tags are stable identifiers used by external NDJSON tools.
  for (const { tag, re } of PROVIDER_PATTERNS) {
    out = out.replace(re, `[redacted:${tag}]`)
  }

  // Provider shapes run first to retain specific tags in URL userinfo.
  out = out.replace(URL_USERINFO, '$1[redacted]@')

  // Labeled redaction wins over coincidental .env-shaped substrings.
  out = redactEnvironmentLines(out)

  return out
}

/** Scan ASCII whitespace directly; defer non-ASCII semantics to the regex engine. */
function skipWhitespace(input: string, index: number): number {
  const length = input.length
  while (index < length) {
    const code = input.charCodeAt(index)
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
      index++
    } else if (code < 0x80) {
      return index
    } else {
      WHITESPACE_RUN.lastIndex = index
      WHITESPACE_RUN.test(input)
      if (WHITESPACE_RUN.lastIndex === index) {
        return index
      }
      index = WHITESPACE_RUN.lastIndex
    }
  }
  return index
}

function redactEnvironmentLines(input: string): string {
  const parts: string[] = []
  let copiedThrough = 0
  let start = 0
  // Search each terminator kind once per occurrence; -2 is unsearched, -1 exhausted.
  const nextTerminator = [-2, -2, -2, -2]
  while (start < input.length) {
    const content = skipWhitespace(input, start)
    if (content === input.length) {
      break
    }
    // Leading whitespace cannot change the first key character; reject impossible starts once.
    const code = input.charCodeAt(content)
    if ((code >= 0x41 && code <= 0x5a) || code === 0x5f) {
      ENV_LINE.lastIndex = start
      const match = ENV_LINE.exec(input)
      if (match) {
        parts.push(input.slice(copiedThrough, start), `${match[1]}=[redacted:env-value]`)
        copiedThrough = ENV_LINE.lastIndex
        start = copiedThrough + 1
        continue
      }
    }
    let terminator = -1
    for (let kind = 0; kind < LINE_TERMINATORS.length; kind++) {
      let next = nextTerminator[kind]!
      if (next !== -1 && next < content) {
        next = input.indexOf(LINE_TERMINATORS[kind]!, content)
        nextTerminator[kind] = next
      }
      if (next !== -1 && (terminator === -1 || next < terminator)) {
        terminator = next
      }
    }
    if (terminator === -1) {
      break
    }
    start = terminator + 1
  }
  if (parts.length === 0) {
    return input
  }
  parts.push(input.slice(copiedThrough))
  return parts.join('')
}
