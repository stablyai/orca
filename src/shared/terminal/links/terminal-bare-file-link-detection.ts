import {
  detectTerminalFileLinkRanges,
  terminalFileLinkRangesOverlap,
  toParsedTerminalFileLink
} from './terminal-file-link-detection-ranges'
import type { ParsedTerminalFileLink } from './terminal-links'

// Match VS Code separators except colon, which belongs to the existing line/column suffix parser.
const WORD_TOKEN_REGEX = /[^\s()[\]{}'",;<>|`]+/g

const EXTENSIONLESS_FILENAMES = new Set([
  'Makefile',
  'Dockerfile',
  'Rakefile',
  'Gemfile',
  'Procfile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'AUTHORS',
  'NOTICE',
  'CONTRIBUTING'
])

const BARE_FILENAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/
const MAX_BARE_FILENAME_TOKEN_LENGTH = 120

function looksLikeFilename(token: string): boolean {
  if (token.length < 2 || token.length > 100) {
    return false
  }
  if (!BARE_FILENAME_PATTERN.test(token)) {
    return false
  }
  if (/^\d+$/.test(token)) {
    return false
  }
  if (token.includes('.')) {
    return !/^\.+$/.test(token)
  }
  return EXTENSIONLESS_FILENAMES.has(token)
}

// Reject obvious prose before filesystem probes while retaining common extensionless project filenames.
export function detectBareFilenameLinks(
  lineText: string,
  claimedRanges: readonly [number, number][]
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  for (const range of detectTerminalFileLinkRanges(lineText, WORD_TOKEN_REGEX)) {
    if (terminalFileLinkRangesOverlap(range, claimedRanges)) {
      continue
    }
    // Bound bare-file candidates before parsing; unbroken terminal blobs must not block hover interaction.
    if (range.text.length > MAX_BARE_FILENAME_TOKEN_LENGTH) {
      continue
    }
    const link = toParsedTerminalFileLink(range)
    if (!link || !looksLikeFilename(link.pathText)) {
      continue
    }
    links.push(link)
  }
  return links
}
