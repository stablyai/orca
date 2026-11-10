import { useTranslate } from '@/i18n/use-translate'
import { AgentDefaultSetting } from './AgentDefaultSetting'
import { AllAgentsPermissionSetting } from '../permissions/AllAgentsPermissionSetting'

export function AgentLaunchSettingsLoading(): React.JSX.Element {
  const t = useTranslate()
  return (
    <fieldset disabled className="min-w-0 space-y-8">
      <AgentDefaultSetting
        defaultAgent="blank"
        detectedIds={null}
        enabledDetectedAgents={[]}
        catalog={[]}
        description={t(
          'settings.agents.hostDefaults',
          'Defaults for new agents on the selected host.'
        )}
        onSetDefault={() => {}}
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
