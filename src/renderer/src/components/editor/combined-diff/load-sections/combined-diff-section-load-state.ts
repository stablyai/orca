import type { DiffLineCounts, LargeDiffRenderLimit } from '../../large-diff-render-limit'
import type { DiffSection } from '../../diff-section-types'

// Why: `diffResult === null` subsumes a dirty check — `dirty` is only ever set from a mounted
// editor's content compare, which implies content was already loaded.
export function shouldRequestCombinedDiffSectionLoad(
  section: Pick<DiffSection, 'diffResult' | 'error'> | undefined,
  isLoading: boolean
): boolean {
  return Boolean(section && section.diffResult === null && !section.error && !isLoading)
}

type ReloadedDiffSectionContent = Pick<
  DiffSection,
  'diffResult' | 'error' | 'largeDiffRenderLimit' | 'originalContent' | 'modifiedContent'
>

type LimitedDiffRenderLimit = Extract<LargeDiffRenderLimit, { limited: true }>

function isSameDiffLineCounts(
  current: DiffLineCounts | null,
  next: DiffLineCounts | null
): boolean {
  if (!current || !next) {
    return current === next
  }
  return current.original === next.original && current.modified === next.modified
}

function isSameLineCountMinimums(
  current: LimitedDiffRenderLimit,
  next: LimitedDiffRenderLimit
): boolean {
  return (
    (current.lineCountsAreMinimum?.original ?? false) ===
      (next.lineCountsAreMinimum?.original ?? false) &&
    (current.lineCountsAreMinimum?.modified ?? false) ===
      (next.lineCountsAreMinimum?.modified ?? false)
  )
}

/**
 * True when a revalidation refetched exactly what the section already displays, so committing it
 * would swap Monaco models and re-measure the row for no visible change.
 *
 * Why: a rebase fires one watcher event per touched path, and most of those refetch identical diffs.
 */
export function isUnchangedDiffSectionReload(
  current: ReloadedDiffSectionContent,
  next: ReloadedDiffSectionContent
): boolean {
  if (current.error !== next.error) {
    return false
  }
  // Only text diffs compare by content; binary/image results carry data this can't see.
  if (current.diffResult?.kind !== 'text' || next.diffResult?.kind !== 'text') {
    return false
  }
  const currentLimit = current.largeDiffRenderLimit
  const nextLimit = next.largeDiffRenderLimit
  if ((currentLimit?.limited ?? false) !== (nextLimit?.limited ?? false)) {
    return false
  }
  // Why: limited sections prune their content to '', so the content compare below can't see a
  // refetch move. The fallback banner renders only this metadata, so it is both the sole change
  // signal and the full description of what's on screen.
  if (currentLimit?.limited === true && nextLimit?.limited === true) {
    return (
      currentLimit.reason === nextLimit.reason &&
      currentLimit.characterCount === nextLimit.characterCount &&
      currentLimit.limits.maxLinesPerSide === nextLimit.limits.maxLinesPerSide &&
      currentLimit.limits.maxCombinedCharacters === nextLimit.limits.maxCombinedCharacters &&
      isSameDiffLineCounts(currentLimit.lineCounts, nextLimit.lineCounts) &&
      isSameLineCountMinimums(currentLimit, nextLimit)
    )
  }
  return (
    current.originalContent === next.originalContent &&
    current.modifiedContent === next.modifiedContent
  )
}
