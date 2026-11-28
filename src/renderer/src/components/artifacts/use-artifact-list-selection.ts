import { useCallback, useMemo, useState } from 'react'
import { areSelectionsEqual, pruneSelection } from '@/lib/list-interaction/list-multi-selection'

const NO_SLUGS: ReadonlySet<string> = new Set()

export type ArtifactListSelection = {
  checkedSlugs: ReadonlySet<string>
  /** Toggles one row; with `range`, sets every row from the anchor to it to that row's new state. */
  toggle: (slug: string, range: boolean) => void
  /** Header checkbox: every visible row when any is unchecked, otherwise none. */
  toggleAllVisible: () => void
  clear: () => void
  headerState: boolean | 'indeterminate'
}

/** Bulk-action checks, kept apart from the drawer's open row so opening a preview never changes the batch. */
export function useArtifactListSelection(visibleSlugs: readonly string[]): ArtifactListSelection {
  const [checkedSlugs, setCheckedSlugs] = useState<ReadonlySet<string>>(NO_SLUGS)
  const [anchorSlug, setAnchorSlug] = useState<string | null>(null)
  const visibleSet = useMemo(() => new Set(visibleSlugs), [visibleSlugs])

  // Why: filters, search and deletes hide rows; acting on rows the user cannot see would surprise them.
  const pruned = pruneSelection(checkedSlugs, anchorSlug, visibleSet)
  if (!areSelectionsEqual(checkedSlugs, pruned.selectedIds)) {
    setCheckedSlugs(pruned.selectedIds.size === 0 ? NO_SLUGS : pruned.selectedIds)
  }
  if (anchorSlug !== pruned.anchorId) {
    setAnchorSlug(pruned.anchorId)
  }

  const clear = useCallback((): void => {
    setCheckedSlugs(NO_SLUGS)
    setAnchorSlug(null)
  }, [])

  const toggle = (slug: string, range: boolean): void => {
    const nextChecked = !checkedSlugs.has(slug)
    const targetIndex = visibleSlugs.indexOf(slug)
    const anchorIndex = range && anchorSlug ? visibleSlugs.indexOf(anchorSlug) : -1
    const slugs =
      anchorIndex === -1 || targetIndex === -1
        ? [slug]
        : visibleSlugs.slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1
          )
    const next = new Set(checkedSlugs)
    for (const each of slugs) {
      if (nextChecked) {
        next.add(each)
      } else {
        next.delete(each)
      }
    }
    setCheckedSlugs(next)
    setAnchorSlug(slug)
  }

  const visibleCheckedCount = checkedSlugs.size
  const headerState =
    visibleCheckedCount === 0
      ? false
      : visibleCheckedCount === visibleSlugs.length
        ? true
        : 'indeterminate'

  return {
    checkedSlugs,
    toggle,
    toggleAllVisible: () => {
      setCheckedSlugs(headerState === true ? NO_SLUGS : new Set(visibleSlugs))
      setAnchorSlug(null)
    },
    clear,
    headerState
  }
}
