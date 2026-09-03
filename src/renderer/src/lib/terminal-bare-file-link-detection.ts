import { trimFileLinkRangeNonAsciiProse } from '../../../shared/non-ascii-terminal-text-boundary'
import {
  detectTerminalFileLinkRanges,
  terminalFileLinkRangesOverlap,
  toParsedTerminalFileLink
} from './terminal-file-link-detection-ranges'
import type { ParsedTerminalFileLink } from './terminal-links'

// Mirrors VSCode's terminal word separators, with `:` handled by the existing
// line/column suffix parser instead of acting as a raw separator.
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

// Why \p{L}\p{M}\p{N}: an ASCII-only name never matched `文書.md`, so a bare
// non-Latin filename was not a link at all (#13396).
const BARE_FILENAME_PATTERN = /^[\p{L}\p{M}\p{N}_][\p{L}\p{M}\p{N}._+-]*$/u
// Why an ASCII extension: with the wider name class, every sentence ending in `.`
// would otherwise reach the filesystem probe.
const BARE_FILENAME_EXTENSION = /\.[A-Za-z0-9_+-]+$/
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
    return BARE_FILENAME_EXTENSION.test(token)
  }
  return EXTENSIONLESS_FILENAMES.has(token)
}

// Bare words are filesystem-validated by the provider, so reject obvious prose
// before paying for a stat while retaining common extensionless project files.
export function detectBareFilenameLinks(
  lineText: string,
  claimedRanges: readonly [number, number][]
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  for (const range of detectTerminalFileLinkRanges(lineText, WORD_TOKEN_REGEX)) {
    if (terminalFileLinkRangesOverlap(range, claimedRanges)) {
      continue
    }
    // Why: huge terminal blobs can be one unbroken token; parse only bounded
    // bare-filename candidates so hover link detection stays interactive.
    if (range.text.length > MAX_BARE_FILENAME_TOKEN_LENGTH) {
      continue
    }
    // Trim first: `README.mdへ` fails looksLikeFilename and never becomes a link.
    const link = toParsedTerminalFileLink(trimFileLinkRangeNonAsciiProse(range))
    if (!link || !looksLikeFilename(link.pathText)) {
      continue
    }
    links.push(link)
  }
  return links
}
