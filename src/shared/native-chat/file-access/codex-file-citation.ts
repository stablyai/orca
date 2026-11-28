import { isWindowsAbsolutePathLike } from '../../file-access/cross-platform-path'

export const CODEX_FILE_CITATION_START = ':codex-file-citation{'
export const CODEX_FILE_CITATION_MAX_LENGTH = 8192

export function parseCodexFileCitation(
  source: string,
  start = 0
): { path: string; label: string; end: number } | null {
  if (!source.startsWith(CODEX_FILE_CITATION_START, start)) {
    return null
  }

  const startOfAttributes = start + CODEX_FILE_CITATION_START.length
  const text = source.slice(startOfAttributes, start + CODEX_FILE_CITATION_MAX_LENGTH)
  const attribute = /[ \t]*([a-z_][a-z0-9_]*)[ \t]*=[ \t]*"((?:\\"|\\(?!")|[^"\\\r\n])*)"/gy
  const attributes = new Map<string, string>()
  let offset = 0
  for (let match = attribute.exec(text); match; match = attribute.exec(text)) {
    if ((offset > 0 && !/^[ \t]/.test(match[0])) || attributes.has(match[1])) {
      return null
    }
    attributes.set(match[1], match[2].replace(/\\"/g, '"'))
    offset = attribute.lastIndex
  }

  const close = /^[ \t]*}/.exec(text.slice(offset))
  const path = attributes.get('path')
  const purpose = attributes.get('purpose')
  // Live connector references have a different host contract than filesystem paths.
  if (!close || !path || attributes.has('mode') || (purpose !== 'source' && purpose !== 'output')) {
    return null
  }
  const windows = isWindowsAbsolutePathLike(path)
  if ((!path.startsWith('/') && !windows) || /\p{Cc}/u.test(path)) {
    return null
  }
  const label = (windows ? path.split(/[\\/]/) : path.split('/')).at(-1)
  return label ? { path, label, end: startOfAttributes + offset + close[0].length } : null
}

export function protectCodexFileCitations(
  source: string,
  repair: (markdown: string) => string
): string {
  const startMarker = '\uE000'
  const endMarker = '\uE001'
  const citations: string[] = []
  let masked = ''
  let end = 0
  for (let start = source.indexOf(CODEX_FILE_CITATION_START); start !== -1;) {
    const citation = parseCodexFileCitation(source, start)
    if (citation) {
      masked += source.slice(end, start) + startMarker + String(citations.length) + endMarker
      citations.push(source.slice(start, citation.end))
      end = citation.end
    }
    start = source.indexOf(
      CODEX_FILE_CITATION_START,
      citation?.end ?? start + CODEX_FILE_CITATION_START.length
    )
  }
  if (citations.length === 0) {
    return repair(source)
  }
  // Leave the block alone if it uses the same marker as the replacement text.
  if (source.includes(startMarker)) {
    return source
  }
  return repair(masked + source.slice(end)).replace(
    /\uE000(\d+)\uE001/g,
    (match, index: string) => citations[Number(index)] ?? match
  )
}
