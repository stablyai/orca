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
  /** What the "{n} selected" live region reads: set only by the user's own checks, never by pruning.
   * `seq` changes on every check so a repeated count still re-announces. */
  announcement: SelectionAnnouncement
}

export type SelectionAnnouncement = { count: number; seq: number }

const SILENT: SelectionAnnouncement = { count: 0, seq: 0 }

/** Bulk-action checks, kept apart from the drawer's open row so opening a preview never changes the batch. */
export function useArtifactListSelection(visibleSlugs: readonly string[]): ArtifactListSelection {
  const [checkedSlugs, setCheckedSlugs] = useState<ReadonlySet<string>>(NO_SLUGS)
  const [anchorSlug, setAnchorSlug] = useState<string | null>(null)
  // Why: a delete batch prunes checked rows one at a time; reading each prune would repeat the count
  // per row, so only the user's own checks announce. The batch's outcome is announced by its own region.
  const [announcement, setAnnouncement] = useState<SelectionAnnouncement>(SILENT)
  const announce = (count: number): void =>
    setAnnouncement((current) => ({ count, seq: current.seq + 1 }))
  const visibleSet = useMemo(() => new Set(visibleSlugs), [visibleSlugs])

  // Why: filters, search and deletes hide rows; acting on rows the user cannot see would surprise them.
  const pruned = pruneSelection(checkedSlugs, anchorSlug, visibleSet)
  if (!areSelectionsEqual(checkedSlugs, pruned.selectedIds)) {
    setCheckedSlugs(pruned.selectedIds.size === 0 ? NO_SLUGS : pruned.selectedIds)
    if (pruned.selectedIds.size === 0 && announcement.count !== 0) {
      // Emptying the live region is silent; it keeps a stale count from swallowing the next check.
      setAnnouncement((current) => ({ count: 0, seq: current.seq }))
    }
  }
  if (anchorSlug !== pruned.anchorId) {
    setAnchorSlug(pruned.anchorId)
  }

  const clear = useCallback((): void => {
    setCheckedSlugs(NO_SLUGS)
    setAnchorSlug(null)
    setAnnouncement((current) => ({ count: 0, seq: current.seq + 1 }))
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
    announce(next.size)
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
      announce(headerState === true ? 0 : visibleSlugs.length)
    },
    clear,
    headerState,
    announcement
  }
}
