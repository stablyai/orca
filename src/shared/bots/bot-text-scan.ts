// The one place that reads bot text for risk: secret lines left out on import, and flags on what a shared
// bot carries (secrets, risky setup commands, hidden characters). A flag is a reason to look; no flag
// never means the text is safe.
import { redactString } from '../observability/redactor'

// "password: x", "API key is x", "Authorization: Bearer x": a secret word, then a value. Matched against
// the line with camelCase and snake_case split, so accessToken and DATABASE_PASSWORD read as words.
const SECRET_LINE =
  /\b(passwords?|passwd|passcodes?|pins?|api ?keys?|secrets?|tokens?|private ?keys?|cookies?|credentials?|authorization)\b.*?(:|=|\bis\b)\s*\S|\bbearer\s+\S/i
// Shapes keys have even where no word names them.
const SECRET_SHAPE =
  /\b(sk-[\w-]{8,}|sk-ant-[\w-]{8,}|xox[abprs]-[\w-]{8,}|xapp-[\w-]{8,}|gh[opsu]_[\w]{8,}|github_pat_\w{8,}|AKIA[0-9A-Z]{12,}|AIza[\w-]{20,}|tvly-[\w-]{8,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/
// A URL's query and sign-in part (user:pass@) often carry its key, as MCP addresses do.
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@"'`<>]+@)?([^\s?#"'`<>]*)\?[^\s#"'`<>]*/gi
const KEY_BLOCK_START = /-----BEGIN [A-Z0-9 ]+-----/
const KEY_BLOCK_END = /-----END [A-Z0-9 ]+-----/

export const BOT_TEXT_LEFT_OUT = '[line left out: it looked like it held a secret]'

function wordsOf(line: string): string {
  return line.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')
}

function looksSecret(line: string): boolean {
  // redactString is the log redactor; anything it would rewrite is a line to leave out.
  return SECRET_LINE.test(wordsOf(line)) || SECRET_SHAPE.test(line) || redactString(line) !== line
}

type SecretRead = {
  /** The line with each URL's query and sign-in part dropped. */
  line: string
  /** `block-start` opens a key block (BEGIN ... END), `block` is inside one, `line` is a secret line. */
  secret: 'block-start' | 'block' | 'line' | null
}

/** Which lines open a key block (BEGIN ... END) or sit inside one, to the end if it never ends. */
function keyBlockLines(lines: readonly string[]): ('block-start' | 'block' | null)[] {
  let inKeyBlock = false
  return lines.map((raw) => {
    const blockStarts = !inKeyBlock && KEY_BLOCK_START.test(raw)
    if (!inKeyBlock && !blockStarts) {
      return null
    }
    inKeyBlock = !KEY_BLOCK_END.test(blockStarts ? raw.replace(KEY_BLOCK_START, '') : raw)
    return blockStarts ? 'block-start' : 'block'
  })
}

function readSecrets(lines: readonly string[]): SecretRead[] {
  const blocks = keyBlockLines(lines)
  return lines.map((raw, index) => {
    const block = blocks[index]
    if (block) {
      return { line: raw, secret: block }
    }
    const line = raw.replace(URL_QUERY, '$1$2?…')
    return { line, secret: looksSecret(line) ? 'line' : null }
  })
}

/** The text with each line that looks like it holds a secret replaced, and how many were. URLs lose
 *  their query; a key block (BEGIN ... END) is left out whole, to the end if it never ends. */
export function redactBotText(text: string): { text: string; leftOut: number } {
  let leftOut = 0
  const lines: string[] = []
  for (const { line, secret } of readSecrets(text.split('\n'))) {
    if (secret === 'block') {
      continue
    }
    if (secret) {
      leftOut++
      lines.push(BOT_TEXT_LEFT_OUT)
    } else {
      lines.push(line)
    }
  }
  return { text: lines.join('\n'), leftOut }
}

export type BotTextFlagKind = 'secret' | 'pipe-to-shell' | 'sudo' | 'sends-file' | 'hidden-unicode'

/** One reason to look at a line; `line` is 1-based. `secret` blocks sharing; the rest are warnings. */
export type BotTextFlag = { kind: BotTextFlagKind; line: number }

// A URL query parameter whose name says it carries a key (`api_key=`, `accessToken=`, `sig=`).
const SECRET_PARAM_WORDS = new Set([
  'key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'sig',
  'signature',
  'auth',
  'credential',
  'credentials'
])

function hasSecretQueryParam(line: string): boolean {
  for (const word of line.split(/\s+/)) {
    const scheme = word.indexOf('://')
    const query = scheme > 0 ? word.indexOf('?', scheme) : -1
    if (query === -1) {
      continue
    }
    // Decoded as a server reads them, so `%74oken=` is the `token` it is.
    for (const [name, value] of new URLSearchParams(word.slice(query + 1).split('#')[0])) {
      const words = wordsOf(name)
        .toLowerCase()
        .split(/[\s.]+/)
      if (value && words.some((part) => SECRET_PARAM_WORDS.has(part))) {
        return true
      }
    }
  }
  return false
}

const FETCH_TOOLS = new Set(['curl', 'wget'])
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
  'python',
  'python3',
  'node',
  'perl',
  'ruby'
])
const COMMAND_SEPARATORS = new Set(['|', '||', '&&', ';'])
// `bash <(curl …)` and `sh -c "$(curl …)"` run a download as surely as a pipe does.
const FETCH_SUBSTITUTION = /(?:<\(|\$\()\s*(?:curl|wget)\b/i
// Options whose value curl sends as the request body; `@file` makes that value a local file.
const DATA_OPTION = /^(?:-d|--data(?:-binary|-raw|-urlencode|-ascii)?|--json)$/
const FORM_OPTION = /^(?:-F|--form)$/
const UPLOAD_OPTION = /^(?:-T|--upload-file)$/

/** The line's words, with pipes, && and ; as words of their own and quotes stripped. */
function commandWords(line: string): string[] {
  return line
    .replace(/\|\|?|&&|;/g, ' $& ')
    .split(/\s+/)
    .map((word) => word.replace(/^["'`(]+|["'`)]+$/g, ''))
    .filter(Boolean)
}

const commandName = (word: string): string => (word.split('/').at(-1) ?? word).toLowerCase()

function pipesToShell(words: readonly string[], line: string): boolean {
  if (FETCH_SUBSTITUTION.test(line)) {
    return true
  }
  let fetched = false
  for (let index = 0; index < words.length; index++) {
    const name = commandName(words[index])
    if (FETCH_TOOLS.has(name)) {
      fetched = true
    } else if (fetched && words[index] === '|') {
      let next = index + 1
      while (next < words.length && commandName(words[next]) === 'sudo') {
        next++
      }
      if (next < words.length && SHELLS.has(commandName(words[next]))) {
        return true
      }
    }
  }
  return false
}

/** `sudo` where a command starts: first on the line, or after a pipe, && or ;. */
function runsSudo(words: readonly string[]): boolean {
  return words.some(
    (word, index) =>
      commandName(word) === 'sudo' &&
      index + 1 < words.length &&
      (index === 0 || COMMAND_SEPARATORS.has(words[index - 1]) || words[index - 1] === '$')
  )
}

/** curl sending a local file: `-d @file`, `--json @file`, `-F field=@file` or `-T file`. */
function sendsFile(words: readonly string[]): boolean {
  let curl = false
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (commandName(word) === 'curl') {
      curl = true
      continue
    }
    if (!curl) {
      continue
    }
    if (COMMAND_SEPARATORS.has(word)) {
      curl = false
      continue
    }
    const equals = word.startsWith('--') ? word.indexOf('=') : -1
    const option = equals === -1 ? word : word.slice(0, equals)
    const value = equals === -1 ? (words[index + 1] ?? '') : word.slice(equals + 1)
    if (
      UPLOAD_OPTION.test(option) ||
      (DATA_OPTION.test(option) && value.startsWith('@')) ||
      (FORM_OPTION.test(option) && /^[^=]*=[@<]/.test(value)) ||
      /^-d@|^-F[^=]*=[@<]/.test(word)
    ) {
      return true
    }
  }
  return false
}

// The characters shared bot text may never carry, the same set as Orca Cloud's unsafe-share-text:
// C0 and C1 controls with DEL, the Bidi_Control set (U+061C, U+200E-U+200F, U+202A-U+202E,
// U+2066-U+2069) and zero-width characters (U+200B-U+200D, U+FEFF). Escaped, since they are invisible.
const UNSAFE_TEXT_SOURCE =
  '[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]'
const UNSAFE_TEXT = new RegExp(UNSAFE_TEXT_SOURCE, 'u')
const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT_SOURCE, 'gu')

/** Whether one-line text (a name, a purpose) holds a character shared text may not carry. */
export function hasUnsafeText(value: string): boolean {
  return UNSAFE_TEXT.test(value)
}

/** The text with each unsafe character replaced by a space. */
export function withoutUnsafeText(value: string): string {
  return value.replace(UNSAFE_TEXT_ALL, ' ')
}

/** A body line (SOUL, skills, memory) may hold tabs and a CRLF's CR; nothing else from the set. */
const hasHiddenUnicode = (line: string): boolean => hasUnsafeText(line.replace(/[\t\r]/g, ''))

const WARNINGS: [BotTextFlagKind, (words: readonly string[], line: string) => boolean][] = [
  ['pipe-to-shell', pipesToShell],
  ['sudo', runsSudo],
  ['sends-file', sendsFile],
  ['hidden-unicode', (_words, line) => hasHiddenUnicode(line)]
]

/** Every flag on the text, at most one of each kind per line, in line order. */
export function scanBotText(text: string): BotTextFlag[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n')
  const flags: BotTextFlag[] = []
  keyBlockLines(lines).forEach((block, index) => {
    const raw = lines[index]
    const line = index + 1
    // Narrower than what import leaves out: only key shapes, key blocks and keys in a URL query.
    if (block !== null || SECRET_SHAPE.test(raw) || hasSecretQueryParam(raw)) {
      flags.push({ kind: 'secret', line })
    }
    const words = commandWords(raw)
    for (const [kind, detect] of WARNINGS) {
      if (detect(words, raw)) {
        flags.push({ kind, line })
      }
    }
  })
  return flags
}

/** A text's line count as an editor shows it: a final newline adds no line. */
export function textLineCount(text: string): number {
  return text.replace(/\n$/, '').split('\n').length
}
