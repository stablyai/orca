import { useTranslate } from '@/i18n/use-translate'
import { AgentLaunchDefaultsGroup } from './AgentLaunchDefaultsGroup'
import { AllAgentsPermissionSetting } from '../permissions/AllAgentsPermissionSetting'

export function AgentLaunchSettingsLoading(): React.JSX.Element {
  const t = useTranslate()
  return (
    <fieldset data-agent-settings-state="pending" disabled className="min-w-0 space-y-8">
      <AgentLaunchDefaultsGroup
        description={t(
          'settings.agents.hostDefaults',
          'Defaults for new agents on the selected host.'
        )}
        permissions={
          <AllAgentsPermissionSetting
            choice={null}
            withoutAutoChoice={null}
            onChange={() => {}}
            onChangeWithoutAuto={() => {}}
          />
        }
      />
    </fieldset>
  )
}
