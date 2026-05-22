import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { ORCHESTRATION_PANE_SEARCH_ENTRIES } from './orchestration-search'
import { OrchestrationSetupCard } from './OrchestrationSetupCard'

export function OrchestrationPane(): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showOrchestration = matchesSettingsSearch(searchQuery, ORCHESTRATION_PANE_SEARCH_ENTRIES)

  if (!showOrchestration) {
    return <div />
  }

  return (
    <SearchableSetting
      title="Agent Orchestration"
      description="Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates."
      keywords={ORCHESTRATION_PANE_SEARCH_ENTRIES[0].keywords}
      className="space-y-3 px-1 py-2"
    >
      <OrchestrationSetupCard />
    </SearchableSetting>
  )
}
