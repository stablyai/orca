import { IntegrationStatusPill } from '../integration-status-pill'
import { SkillFreshnessStatusPill } from '../skills/SkillFreshnessStatusPill'
import { translate } from '@/i18n/i18n'

export function AgentSkillSetupPresenceStatus(props: {
  setupFailed: boolean
  stalled: boolean
  installing: boolean
  loading: boolean
  installed: boolean
  freshnessSkillName?: string
}): React.JSX.Element {
  if (props.setupFailed) {
    return (
      <IntegrationStatusPill tone="attention">
        {translate('auto.components.settings.AgentSkillSetupPanel.setupFailed', 'Setup failed')}
      </IntegrationStatusPill>
    )
  }
  if (props.stalled) {
    return (
      <IntegrationStatusPill tone="attention">
        {translate(
          'auto.components.settings.AgentSkillSetupPanel.waitingForInput',
          'Waiting for input'
        )}
      </IntegrationStatusPill>
    )
  }
  if (props.installing) {
    return (
      <IntegrationStatusPill tone="neutral">
        {translate('auto.components.settings.AgentSkillSetupPanel.installing', 'Installing...')}
      </IntegrationStatusPill>
    )
  }
  if (props.loading && !props.installed) {
    return (
      <IntegrationStatusPill tone="neutral">
        {translate('auto.components.settings.AgentSkillSetupPanel.68a468752e', 'Checking...')}
      </IntegrationStatusPill>
    )
  }
  if (props.installed) {
    return props.freshnessSkillName ? (
      <SkillFreshnessStatusPill skillName={props.freshnessSkillName} />
    ) : (
      <IntegrationStatusPill tone="connected">
        {translate('auto.components.settings.AgentSkillSetupPanel.9fcebceb2a', 'Installed')}
      </IntegrationStatusPill>
    )
  }
  return (
    <IntegrationStatusPill tone="attention">
      {translate('auto.components.settings.AgentSkillSetupPanel.5289300939', 'Not installed')}
    </IntegrationStatusPill>
  )
}
