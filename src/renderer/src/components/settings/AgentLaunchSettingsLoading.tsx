import { translate } from '@/i18n/i18n'
import { AgentDefaultSetting } from './AgentDefaultSetting'
import { AllAgentsPermissionSetting } from './AgentPermissionChoiceControls'

export function AgentLaunchSettingsLoading(): React.JSX.Element {
  return (
    <fieldset disabled className="min-w-0 space-y-8">
      <AgentDefaultSetting
        defaultAgent="blank"
        detectedIds={null}
        enabledDetectedAgents={[]}
        catalog={[]}
        description={translate(
          'settings.agents.hostDefaults',
          'Defaults for new agents on the selected host.'
        )}
        onSetDefault={() => {}}
      />
      <AllAgentsPermissionSetting
        choice={null}
        withoutAutoChoice={null}
        onChange={() => {}}
        onChangeWithoutAuto={() => {}}
      />
    </fieldset>
  )
}
