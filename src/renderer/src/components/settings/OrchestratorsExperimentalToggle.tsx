import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { SettingsSwitch } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getExperimentalSearchEntry } from './experimental-search'
import { translate } from '@/i18n/i18n'

type OrchestratorsExperimentalToggleProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  searchQuery: string
}

// Why: extracted from ExperimentalPane to keep that file under the max-lines
// cap; this owns the single Orcastrators experimental toggle row.
export function OrchestratorsExperimentalToggle({
  settings,
  updateSettings,
  searchQuery
}: OrchestratorsExperimentalToggleProps): React.JSX.Element | null {
  const show = matchesSettingsSearch(searchQuery, [getExperimentalSearchEntry().orchestrators])
  if (!show) {
    return null
  }
  const enabled = settings.experimentalOrchestrators ?? false
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ExperimentalPane.orchestrators.title',
        'Orcastrators'
      )}
      description={translate(
        'auto.components.settings.ExperimentalPane.orchestrators.description',
        'A sidebar section for launching persistent coordinator chats that plan and run multi-worktree work.'
      )}
      keywords={getExperimentalSearchEntry().orchestrators.keywords}
      className="space-y-3 py-2"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label id="orchestrators-experimental-toggle-label">
            {translate(
              'auto.components.settings.ExperimentalPane.orchestrators.title',
              'Orcastrators'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.orchestrators.detail',
              'Adds an "Orcastrators" section above Projects. Launch a coordinator chat per repo — it plans the work, spins up worktrees and worker agents, and supervises them. Experimental while the create-flow and multi-coordinator isolation are settling.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          onChange={() =>
            updateSettings({ experimentalOrchestrators: !settings.experimentalOrchestrators })
          }
          ariaLabelledBy="orchestrators-experimental-toggle-label"
        />
      </div>
    </SearchableSetting>
  )
}
