import { useEffect, useLayoutEffect, useRef } from 'react'
import { usePluginPreviewRequestStore } from '@/store/plugin-preview-request'
import { NO_PLUGIN_LIST_FILTER, type PluginListFilter } from '../list/plugin-list-filter'

type PluginBrowseTargets = {
  page: { openKey: string | null; back: () => void }
  setTab: (tab: 'all') => void
  setSearch: (search: string) => void
  setListFilter: (filter: PluginListFilter) => void
}

/** Shows the whole list narrowed to the kind asked for from outside Settings, once per ask. */
export function usePluginBrowseRequest(targets: PluginBrowseTargets): void {
  const browseKind = usePluginPreviewRequestStore((state) => state.browseKind)
  const targetsRef = useRef(targets)
  useLayoutEffect(() => {
    targetsRef.current = targets
  })
  // Why an effect: a request can arrive while the list is already showing.
  useEffect(() => {
    if (!browseKind) {
      return
    }
    usePluginPreviewRequestStore.setState({ browseKind: null })
    const { page, setTab, setSearch, setListFilter } = targetsRef.current
    setTab('all')
    setSearch('')
    setListFilter({ ...NO_PLUGIN_LIST_FILTER, categories: new Set([browseKind]) })
    if (page.openKey !== null) {
      page.back()
    }
  }, [browseKind])
}
