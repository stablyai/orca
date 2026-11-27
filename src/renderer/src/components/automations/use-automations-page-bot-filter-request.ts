import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import type { AutomationHostFilter } from '../../../../shared/automations/ownership/automation-host-filter'
import { botListFilter } from './listing/automation-list-view'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageNavigation } from './automations-page-navigation'

/** Apply a bot's "All N automations": its automations on the list, on every host, unsearched. */
export function useAutomationsPageBotFilterRequest({
  local,
  navigation,
  selectHost
}: {
  local: Pick<AutomationsPageLocalState, 'setListFilter' | 'setListSearchQuery'>
  navigation: Pick<AutomationsPageNavigation, 'showList'>
  selectHost: (filter: AutomationHostFilter) => void
}): void {
  const request = useAppStore((s) => s.automationsPageBotFilterRequest)
  const { setListFilter, setListSearchQuery } = local
  const { showList } = navigation
  useEffect(() => {
    if (!request) {
      return
    }
    // Cleared at once, so a later run of this effect (new deps) finds nothing to apply.
    useAppStore.getState().setAutomationsPageBotFilterRequest(null)
    setListFilter(botListFilter(request))
    setListSearchQuery('')
    showList()
    // The stored choice, not the effective one: a host dropped from the catalog may come back.
    if (useAppStore.getState().automationHostFilter.kind !== 'all') {
      selectHost({ kind: 'all' })
    }
  }, [request, setListFilter, setListSearchQuery, showList, selectHost])
}
