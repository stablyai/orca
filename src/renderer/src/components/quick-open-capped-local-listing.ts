import { useMemo, useRef, useState } from 'react'
import { splitFileNameFilterTokens } from '../../../shared/file-name-filter-tokens'

/** Last capped local listing; name filters re-list such workspaces on the host. */
export type CappedLocalListing = { key: string; hostFilterFailed: boolean }

/** Files from the last capped local listing, keyed like {@link CappedLocalListing}. */
type CappedListingFiles = { key: string; files: string[] }

export function nextCappedLocalListing(
  current: CappedLocalListing | null,
  key: string,
  truncated: boolean
): CappedLocalListing | null {
  // Why: a failed host filter stays failed so re-listing the same workspace does not retry it.
  return truncated
    ? { key, hostFilterFailed: current?.key === key && current.hostFilterFailed }
    : null
}

/** Host name-filter matches first, then the capped listing so fuzzy-only matches still rank. */
export function mergeCappedListingFiles<T extends { files: string[] }>(
  filtered: T,
  capped: CappedListingFiles | null,
  key: string
): T {
  if (capped?.key !== key) {
    return filtered
  }
  const seen = new Set(filtered.files)
  return { ...filtered, files: [...filtered.files, ...capped.files.filter((f) => !seen.has(f))] }
}

/** Tracks whether the local listing for `listingKey` hit its cap and, if so, the host name filter. */
export function useCappedLocalListing({
  listingKey,
  eligible,
  query,
  keepCappedFiles
}: {
  listingKey: string
  /** Whether a capped listing may be re-listed with the name filter applied on the host. */
  eligible: boolean
  query: string | undefined
  keepCappedFiles: boolean
}) {
  const [capped, setCapped] = useState<CappedLocalListing | null>(null)
  const filesRef = useRef<CappedListingFiles | null>(null)
  const keepRef = useRef(keepCappedFiles)
  keepRef.current = keepCappedFiles
  // Why: a capped listing can omit matches, so only then pay for a host scan per query.
  const hostNameFilter =
    eligible && capped?.key === listingKey && !capped.hostFilterFailed
      ? splitFileNameFilterTokens(query ?? '').join(' ')
      : ''
  const actions = useMemo(
    () => ({
      reset: () => setCapped(null),
      record: (key: string, files: string[], truncated: boolean) => {
        filesRef.current = truncated ? { key, files } : null
        setCapped((current) => nextCappedLocalListing(current, key, truncated))
      },
      // Why: a failed host scan falls back to filtering the capped listing, not an error.
      markHostFilterFailed: () =>
        setCapped((current) => current && { ...current, hostFilterFailed: true }),
      mergeInto: <T extends { files: string[] }>(filtered: T, key: string): T =>
        keepRef.current ? mergeCappedListingFiles(filtered, filesRef.current, key) : filtered
    }),
    []
  )
  return { hostNameFilter, actions }
}
