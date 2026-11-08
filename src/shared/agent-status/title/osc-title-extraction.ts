const ESC_CODE_UNIT = 0x1b
const BEL_CODE_UNIT = 0x07
const RIGHT_BRACKET_CODE_UNIT = 0x5d
const BACKSLASH_CODE_UNIT = 0x5c
const SEMICOLON_CODE_UNIT = 0x3b
const OSC_TITLE_COMMANDS = new Set([0x30, 0x31, 0x32])
export const MAX_OSC_TITLE_CHARS = 1024
export const MAX_OSC_TITLES_PER_CHUNK = 4096

type OscTitleParseResult =
  | { kind: 'title'; title: string; nextIndex: number }
  | { kind: 'invalid'; nextIndex: number }
  | { kind: 'incomplete' }

function isOscIntroducerAt(data: string, index: number): boolean {
  return (
    data.charCodeAt(index) === ESC_CODE_UNIT &&
    data.charCodeAt(index + 1) === RIGHT_BRACKET_CODE_UNIT
  )
}

function parseOscTitleAt(data: string, index: number): OscTitleParseResult {
  if (!isOscIntroducerAt(data, index)) {
    return { kind: 'invalid', nextIndex: index + 1 }
  }
  if (
    !OSC_TITLE_COMMANDS.has(data.charCodeAt(index + 2)) ||
    data.charCodeAt(index + 3) !== SEMICOLON_CODE_UNIT
  ) {
    return { kind: 'invalid', nextIndex: index + 2 }
  }

  const titleStart = index + 4
  for (let cursor = titleStart; cursor < data.length; cursor += 1) {
    const code = data.charCodeAt(cursor)
    if (code === BEL_CODE_UNIT) {
      return {
        kind: 'title',
        title: readBoundedOscTitle(data, titleStart, cursor),
        nextIndex: cursor + 1
      }
    }
    if (code !== ESC_CODE_UNIT) {
      continue
    }
    if (data.charCodeAt(cursor + 1) === BACKSLASH_CODE_UNIT) {
      return {
        kind: 'title',
        title: readBoundedOscTitle(data, titleStart, cursor),
        nextIndex: cursor + 2
      }
    }
    return { kind: 'invalid', nextIndex: cursor }
  }

  return { kind: 'incomplete' }
}

function readBoundedOscTitle(data: string, titleStart: number, titleEnd: number): string {
  // Bound remote/pasted OSC title work while retaining trailing status words.
  const length = titleEnd - titleStart
  if (length <= MAX_OSC_TITLE_CHARS) {
    return data.slice(titleStart, titleEnd)
  }
  const prefixLength = Math.ceil(MAX_OSC_TITLE_CHARS / 2)
  const suffixLength = MAX_OSC_TITLE_CHARS - prefixLength
  return (
    data.slice(titleStart, titleStart + prefixLength) +
    data.slice(titleEnd - suffixLength, titleEnd)
  )
}

export function extractLastOscTitle(data: string): string | null {
  if (!data.includes('\x1b]')) {
    return null
  }

  let last: string | null = null
  let searchStart = 0
  // Direct scanning avoids a global regex over arbitrarily large pasted PTY chunks.
  while (searchStart < data.length) {
    const start = data.indexOf('\x1b]', searchStart)
    if (start === -1) {
      break
    }
    const parsed = parseOscTitleAt(data, start)
    if (parsed.kind === 'incomplete') {
      break
    }
    if (parsed.kind === 'title') {
      last = parsed.title
      searchStart = parsed.nextIndex
      continue
    }
    searchStart = parsed.nextIndex
  }
  return last
}

export function extractAllOscTitles(data: string): string[] {
  return scanAllOscTitles(data, (title) => title)
}

/** Every complete OSC title with the offset just past it, for ordering titles against other events. */
export function extractAllOscTitleEntries(data: string): { title: string; end: number }[] {
  return scanAllOscTitles(data, (title, end) => ({ title, end }))
}

function scanAllOscTitles<T>(data: string, make: (title: string, end: number) => T): T[] {
  if (!data.includes('\x1b]')) {
    return []
  }

  const titles: T[] = []
  let oldestTitleIndex = 0
  let searchStart = 0
  while (searchStart < data.length) {
    const start = data.indexOf('\x1b]', searchStart)
    if (start === -1) {
      break
    }
    const parsed = parseOscTitleAt(data, start)
    if (parsed.kind === 'incomplete') {
      break
    }
    if (parsed.kind === 'title') {
      const entry = make(parsed.title, parsed.nextIndex)
      if (titles.length < MAX_OSC_TITLES_PER_CHUNK) {
        titles.push(entry)
      } else {
        titles[oldestTitleIndex] = entry
        oldestTitleIndex = (oldestTitleIndex + 1) % MAX_OSC_TITLES_PER_CHUNK
      }
      searchStart = parsed.nextIndex
      continue
    }
    searchStart = parsed.nextIndex
  }
  return oldestTitleIndex === 0
    ? titles
    : [...titles.slice(oldestTitleIndex), ...titles.slice(0, oldestTitleIndex)]
}
