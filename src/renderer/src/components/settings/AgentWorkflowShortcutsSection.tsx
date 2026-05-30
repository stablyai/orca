import type { GlobalSettings } from '../../../../shared/types'
import {
  SIDEBAR_QUICK_CREATE_DESCRIPTION,
  SIDEBAR_QUICK_CREATE_SEARCH_KEYWORDS,
  SIDEBAR_QUICK_CREATE_TITLE
} from './agent-workflow-shortcuts-copy'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type AgentWorkflowShortcutsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AgentWorkflowShortcutsSection({
  settings,
  updateSettings
}: AgentWorkflowShortcutsSectionProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SearchableSetting
        title={SIDEBAR_QUICK_CREATE_TITLE}
        description={SIDEBAR_QUICK_CREATE_DESCRIPTION}
        keywords={SIDEBAR_QUICK_CREATE_SEARCH_KEYWORDS}
      >
        <SettingsSwitchRow
          label={SIDEBAR_QUICK_CREATE_TITLE}
          description={SIDEBAR_QUICK_CREATE_DESCRIPTION}
          checked={settings.quickCreateWorkspaceWithDefaultAgent}
          onChange={() =>
            updateSettings({
              quickCreateWorkspaceWithDefaultAgent: !settings.quickCreateWorkspaceWithDefaultAgent
            })
          }
          ariaLabel={SIDEBAR_QUICK_CREATE_TITLE}
        />
      </SearchableSetting>
    </section>
  )
}
