import { useState } from 'react'
import { boundHostList, HOST_LIST_ROW_LIMIT, type BoundedHostList } from './bounded-host-list'

/** Bound pinned and other hosts separately; offer search only when the host count exceeds one page. */
export function useBoundedHostRows<T extends { id: string; label: string }>(
  hosts: readonly T[],
  pinnedIds?: ReadonlySet<string>
): BoundedHostList<T> & {
  query: string
  setQuery: (query: string) => void
  searchable: boolean
} {
  const [query, setQuery] = useState('')
  const searchable = hosts.length > HOST_LIST_ROW_LIMIT || query !== ''
  return { ...boundHostList(hosts, { query, pinnedIds }), query, setQuery, searchable }
}
