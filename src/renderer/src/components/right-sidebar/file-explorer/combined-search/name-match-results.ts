import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { normalizeRelativePath } from '../../../../../../shared/file-access/cross-platform-path'
import { compareFileNames } from '../../../../../../shared/file-listing/file-name-sort'
import {
  isFileNameFilterQueryTooLarge,
  lowerTextIncludesFileNameFilterToken,
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../../../../../shared/file-listing/file-name-filter-tokens'
import { composeQuickOpenText } from '../../../../../../shared/quick-open/quick-open-path-search'
import { isDotfileRelativePath } from '../tree/file-explorer-entries'

export const NAME_MATCH_PREVIEW_LIMIT = 5

export function isNameFilterQueryTooLarge(query: string): boolean {
  return isFileNameFilterQueryTooLarge(query)
}

function getNameFilterTokens(query: string): string[] {
  return isFileNameFilterQueryTooLarge(query) ? [] : splitFileNameFilterTokens(query)
}

export type NameMatch = {
  relativePath: string
  name: string
  dir: string
  /** Basename ranges to highlight, sorted and non-overlapping. */
  ranges: readonly (readonly [number, number])[]
  /** Git-ignored; set only after the rendered rows are checked. */
  ignored?: boolean
}

export type NameMatchResults = {
  total: number
  matches: NameMatch[]
}

type RankedPath = { relativePath: string; nameStart: number; nameHit: boolean }

function compareRanked(a: RankedPath, b: RankedPath): number {
  if (a.nameHit !== b.nameHit) {
    return a.nameHit ? -1 : 1
  }
  if (a.relativePath.length !== b.relativePath.length) {
    return a.relativePath.length - b.relativePath.length
  }
  return compareFileNames(a.relativePath, b.relativePath)
}

function getBasenameStart(relativePath: string): number {
  return relativePath.lastIndexOf('/') + 1
}

const NON_ASCII = /[\u0080-\u{10ffff}]/u
let graphemeSegmenter: Intl.Segmenter | undefined

/** Finds `token` in the composed (NFC) form of `lower` and maps the hit back to `lower`'s offsets, so a decomposed (NFD) name highlights the characters typed composed. */
function findComposedRange(lower: string, token: string): [number, number] | null {
  // Composing cannot make an ASCII token match where it did not match as is.
  if (!NON_ASCII.test(token)) {
    return null
  }
  graphemeSegmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' })
  const composedToken = composeQuickOpenText(token)
  // Composed offset of each grapheme boundary → the same boundary in `lower`.
  const boundaries = new Map<number, number>([[0, 0]])
  let composed = ''
  for (const { segment, index } of graphemeSegmenter.segment(lower)) {
    composed += composeQuickOpenText(segment)
    boundaries.set(composed.length, index + segment.length)
  }
  const start = composed.indexOf(composedToken)
  const from = boundaries.get(start)
  const to = boundaries.get(start + composedToken.length)
  // A hit that starts or ends inside a grapheme has no clean range to highlight.
  return start === -1 || from === undefined || to === undefined ? null : [from, to]
}

export function getNameMatchRanges(
  name: string,
  tokens: readonly string[]
): (readonly [number, number])[] {
  const lower = name.toLowerCase()
  // Case folding that changes length would misalign ranges with the visible name.
  if (lower.length !== name.length) {
    return []
  }
  const ranges: [number, number][] = []
  for (const token of tokens) {
    if (token.length === 0) {
      continue
    }
    const start = lower.indexOf(token)
    if (start !== -1) {
      ranges.push([start, start + token.length])
      continue
    }
    const composedRange = findComposedRange(lower, token)
    if (composedRange) {
      ranges.push(composedRange)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push([range[0], range[1]])
    }
  }
  return merged
}

/** Filters listed files by the explorer name tokens; selects only `limit` best rows so typing never sorts the whole match set. */
export function findNameMatches({
  relativePaths,
  query,
  worktreePath,
  displayRootPath,
  showDotfiles,
  limit
}: {
  relativePaths: readonly string[]
  query: string
  worktreePath: string
  displayRootPath: string
  showDotfiles: boolean
  /** null returns every match, fully sorted. */
  limit: number | null
}): NameMatchResults {
  const tokens = getNameFilterTokens(query)
  if (tokens.length === 0) {
    return { total: 0, matches: [] }
  }
  const scoped = displayRootPath !== worktreePath
  let total = 0
  const kept: RankedPath[] = []
  for (const rawRelativePath of relativePaths) {
    const relativePath = normalizeRelativePath(rawRelativePath, worktreePath)
    if (!relativePath || !pathMatchesFileNameFilterTokens(relativePath, tokens)) {
      continue
    }
    if (
      scoped &&
      getRelativePathInsideRoot(joinPath(worktreePath, relativePath), displayRootPath) === null
    ) {
      continue
    }
    if (!showDotfiles && isDotfileRelativePath(relativePath, worktreePath)) {
      continue
    }
    total += 1
    const nameStart = getBasenameStart(relativePath)
    const lowerName = relativePath.slice(nameStart).toLowerCase()
    const candidate = {
      relativePath,
      nameStart,
      nameHit: tokens.every((token) => lowerTextIncludesFileNameFilterToken(lowerName, token))
    }
    if (limit === null) {
      kept.push(candidate)
      continue
    }
    if (kept.length === limit && compareRanked(candidate, kept[limit - 1]) >= 0) {
      continue
    }
    let index = kept.length
    while (index > 0 && compareRanked(candidate, kept[index - 1]) < 0) {
      index -= 1
    }
    kept.splice(index, 0, candidate)
    if (kept.length > limit) {
      kept.pop()
    }
  }
  if (limit === null) {
    kept.sort(compareRanked)
  }
  return {
    total,
    matches: kept.map(({ relativePath, nameStart }) => {
      const name = relativePath.slice(nameStart)
      return {
        relativePath,
        name,
        dir: nameStart > 0 ? relativePath.slice(0, nameStart - 1) : '',
        ranges: getNameMatchRanges(name, tokens)
      }
    })
  }
}
