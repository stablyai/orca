// Slack readers cannot open private host paths; reduce recognized targets without file I/O.

const SEGMENT = String.raw`[^\s\\/()<>\[\]{}\x60"'|*]+`
// A root ends at a separator, the end, a non-word character, or a sentence's full stop.
const END = String.raw`(?=[\\/]|$|[^\w.-]|\.(?![\w-]))`
const HOME = String.raw`(?:~|\$HOME|\/root|\/(?:Users|home)\/${SEGMENT}|\/mnt\/[A-Za-z]\/Users\/${SEGMENT}|[A-Za-z]:[\\/]Users[\\/]${SEGMENT})`
const FILE_SCHEME = String.raw`[fF][iI][lL][eE]:`
const ROOT = String.raw`(?:${FILE_SCHEME}\/\/(?:\/(?=[A-Za-z]:))?)?(?:${HOME}|\/(?:Users|home|tmp|private|var\/folders|var\/tmp)|\/mnt\/[A-Za-z]\/Users|[A-Za-z]:[\\/]Users)${END}`
const PATH_CHARS = String.raw`[^\s()<>\[\]{}\x60"'|*]{0,4096}`
// CommonMark-style: one level of balanced brackets in a label, parentheses in a destination.
const LABEL = String.raw`(?:[^[\]\n]|\[[^[\]\n]{0,1000}\]){0,1000}`
const DESTINATION = String.raw`(?:[^()\n]|\([^()\n]{0,4096}\)){0,4096}`
// Whole references first; remote URL targets are skipped before looking for another reference.
const REFERENCE = new RegExp(
  [
    String.raw`(?<markdown>!?\[(?<markdownLabel>${LABEL})\]\(\s{0,4096}(?<markdownScheme>(?!${FILE_SCHEME})[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/))`,
    String.raw`!\[(?<alt>${LABEL})\]\((?<image>${DESTINATION})(?<!\\)\)`,
    String.raw`\[(?<label>${LABEL})\]\((?<link>${DESTINATION})(?<!\\)\)`,
    String.raw`<(?<slack>[^<>|\n]{1,4096})(?:\|(?<slackLabel>[^<>\n]{0,1000}))?>`,
    String.raw`(?<remote>(?<![\w.+-])(?!${FILE_SCHEME})[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)`,
    String.raw`(?<bare>(?<![\w./:~$%-])${ROOT}${PATH_CHARS})`
  ].join('|'),
  'g'
)
const STARTS_LOCAL = new RegExp(String.raw`^${ROOT}`)
const HOME_PREFIX = new RegExp(String.raw`^${HOME}(?=[\\/]|$)`)
const URL_STOP = /[\s<>"'\x60]/
const MARKDOWN_URL_STOP = /\s/
const TRAILING_PUNCTUATION = /[.,;:!?]+$/
const MAX_MARKDOWN_TARGET_CHARS = 4096

type MarkdownDelimiters = { ends: Int32Array; uriStops: Int32Array }
type MarkdownValidation = { delimiters?: MarkdownDelimiters }
type MarkdownReference = { end: number; titleStart?: number }

function targetOf(raw: string): string {
  const trimmed = raw.trim().replace(/\s+"[^"]*"$/, '')
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed
}

/** A local path's file name; the home folder itself is `~`. Never empty. */
function nameOf(path: string): string {
  const local = path.replace(/^file:\/\/(?:\/(?=[A-Za-z]:))?/i, '')
  const home = HOME_PREFIX.exec(local)?.[0]
  if (home !== undefined && /^[\\/]*$/.test(local.slice(home.length))) {
    return '~'
  }
  return local.split(/[\\/]+/).findLast(Boolean) ?? '~'
}

const isLocal = (target: string): boolean => STARTS_LOCAL.test(target)

function isMarkdownEscape(text: string, index: number): boolean {
  const code = text.charCodeAt(index + 1)
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  )
}

function isInvalidMarkdownUriChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 0x20 || code === 0x7f || /[<>"\x60]/.test(char)
}

// Index delimiters once so rejected titles cannot repeatedly walk overlapping suffixes.
function indexMarkdownDelimiters(text: string): MarkdownDelimiters {
  const ends = new Int32Array(text.length)
  const uriStops = new Int32Array(text.length)
  const openings = new Int32Array(Math.min(text.length, MAX_MARKDOWN_TARGET_CHARS))
  let first = 0
  let count = 0
  let singleQuote = -1
  let doubleQuote = -1
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\\' && isMarkdownEscape(text, index)) {
      index++
      continue
    }
    if (MARKDOWN_URL_STOP.test(char)) {
      const start = index
      while (index < text.length && MARKDOWN_URL_STOP.test(text[index])) {
        uriStops[index++] = 1
      }
      for (let space = start; space < index; space++) {
        ends[space] = index + 1
      }
      index--
      continue
    }
    if (isInvalidMarkdownUriChar(char)) {
      uriStops[index] = 1
    }
    if (char === '(') {
      if (count === openings.length) {
        first = (first + 1) % openings.length
        count--
      }
      openings[(first + count) % openings.length] = index
      count++
    } else if (char === ')' && count > 0) {
      count--
      const opening = openings[(first + count) % openings.length]
      if (index - opening < MAX_MARKDOWN_TARGET_CHARS) {
        ends[opening] = index + 1
      }
    } else if (char === "'") {
      if (singleQuote >= 0) {
        ends[singleQuote] = index + 1
      }
      singleQuote = index
    } else if (char === '"') {
      if (doubleQuote >= 0) {
        ends[doubleQuote] = index + 1
      }
      doubleQuote = index
    }
  }
  let nextStop = text.length
  for (let index = text.length - 1; index >= 0; index--) {
    if (uriStops[index] === 1) {
      nextStop = index
    }
    uriStops[index] = nextStop
  }
  return { ends, uriStops }
}

function afterMarkdownSpace(text: string, index: number, delimiters: MarkdownDelimiters): number {
  return MARKDOWN_URL_STOP.test(text[index] ?? '') ? delimiters.ends[index] - 1 : index
}

function markdownTitleEnd(
  text: string,
  start: number,
  limit: number,
  delimiters: MarkdownDelimiters
): number | undefined {
  const index = afterMarkdownSpace(text, start, delimiters)
  if (index >= limit) {
    return undefined
  }
  if (text[index] === ')') {
    return index + 1
  }
  const opening = text[index]
  if (opening !== '"' && opening !== "'" && opening !== '(') {
    return undefined
  }
  const closing = delimiters.ends[index] - 1
  if (closing <= index || closing >= limit) {
    return undefined
  }
  const end = afterMarkdownSpace(text, closing + 1, delimiters)
  return end < limit && text[end] === ')' ? end + 1 : undefined
}

function markdownReferenceEnd(
  text: string,
  start: number,
  targetStart: number,
  validation: MarkdownValidation
): MarkdownReference | undefined {
  const limit = Math.min(text.length, targetStart + MAX_MARKDOWN_TARGET_CHARS)
  for (let index = start; index < limit; index++) {
    const char = text[index]
    if (char === '\\' && isMarkdownEscape(text, index)) {
      index++
      continue
    }
    if (MARKDOWN_URL_STOP.test(char)) {
      const delimiters = (validation.delimiters ??= indexMarkdownDelimiters(text))
      const end = markdownTitleEnd(text, index, limit, delimiters)
      return end === undefined ? undefined : { end, titleStart: index }
    }
    if (isInvalidMarkdownUriChar(char)) {
      return undefined
    }
    if (char === '(') {
      const delimiters = (validation.delimiters ??= indexMarkdownDelimiters(text))
      const stop = delimiters.uriStops[index] ?? text.length
      const closing = delimiters.ends[index] - 1
      if (closing <= index || closing >= limit || closing >= stop) {
        return undefined
      }
      index = closing
    } else if (char === ')') {
      return { end: index + 1 }
    }
  }
  return undefined
}

function remoteUrlEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (URL_STOP.test(text[index])) {
      return index
    }
  }
  return text.length
}

function escapedAt(text: string, index: number): boolean {
  let backslashes = 0
  while (index > 0 && text[--index] === '\\') {
    backslashes++
  }
  return backslashes % 2 !== 0
}

function localReferenceText(whole: string, groups: Record<string, string | undefined>): string {
  if (groups.image !== undefined) {
    const target = targetOf(groups.image)
    const alt = redactLocalPaths(groups.alt ?? '')
    return isLocal(target)
      ? alt.trim() || nameOf(target)
      : `![${alt}](${redactLocalPaths(groups.image)})`
  }
  if (groups.link !== undefined) {
    const target = targetOf(groups.link)
    const label = redactLocalPaths(groups.label ?? '')
    return isLocal(target)
      ? label.trim() || nameOf(target)
      : `[${label}](${redactLocalPaths(groups.link)})`
  }
  if (groups.slack !== undefined) {
    const target = groups.slack.trim()
    const label = groups.slackLabel === undefined ? undefined : redactLocalPaths(groups.slackLabel)
    if (isLocal(target)) {
      return label?.trim() || nameOf(target)
    }
    return label === undefined ? whole : `<${groups.slack}|${label}>`
  }
  if (groups.bare !== undefined) {
    const trailing = TRAILING_PUNCTUATION.exec(whole)?.[0] ?? ''
    return nameOf(whole.slice(0, whole.length - trailing.length)) + trailing
  }
  return whole
}

/** Recognized local targets become names or labels; excluded and relative targets stay as written. */
export function redactLocalPaths(text: string): string {
  if (!text) {
    return text
  }
  const scan = new RegExp(REFERENCE)
  const parts: string[] = []
  let copied = 0
  const validation: MarkdownValidation = {}
  for (let match = scan.exec(text); match; match = scan.exec(text)) {
    const groups = match.groups ?? {}
    if (groups.markdown !== undefined) {
      const label = groups.markdownLabel ?? ''
      const labelStart = match.index + (match[0].startsWith('!') ? 2 : 1)
      const replacement = redactLocalPaths(label)
      if (replacement !== label) {
        parts.push(text.slice(copied, labelStart), replacement)
        copied = labelStart + label.length
      }
      const reference =
        escapedAt(text, labelStart - 1) || escapedAt(label, label.length)
          ? undefined
          : markdownReferenceEnd(
              text,
              scan.lastIndex,
              scan.lastIndex - (groups.markdownScheme?.length ?? 0),
              validation
            )
      if (reference?.titleStart !== undefined) {
        const title = text.slice(reference.titleStart, reference.end)
        const redactedTitle = redactLocalPaths(title)
        if (title !== redactedTitle) {
          parts.push(text.slice(copied, reference.titleStart), redactedTitle)
          copied = reference.end
        }
      }
      scan.lastIndex = reference?.end ?? remoteUrlEnd(text, scan.lastIndex)
      continue
    }
    if (groups.remote !== undefined) {
      scan.lastIndex = remoteUrlEnd(text, scan.lastIndex)
      continue
    }
    let end = scan.lastIndex
    if (groups.bare !== undefined && text[end - 1] === '\\' && isMarkdownEscape(text, end - 1)) {
      while (text[end - 1] === '\\') {
        end--
      }
    }
    const whole = text.slice(match.index, end)
    const replacement = localReferenceText(whole, groups)
    if (replacement !== whole) {
      parts.push(text.slice(copied, match.index), replacement)
      copied = end
    }
  }
  return copied === 0 ? text : parts.join('') + text.slice(copied)
}
