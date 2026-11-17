import { AgentApiKeysSection } from '../agent-api-keys/AgentApiKeysSection'
import { AgentApiKeysCloudDescription } from '../agent-api-keys/AgentApiKeysCloudDescription'
import { SettingsSection } from '../section-layout/SettingsSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

export function renderAgentApiKeysSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view, actions } = context
  return model.showDesktopOnlySettings ? (
    <SettingsSection
      id="agent-api-keys"
      title={t('settings.agentApiKeys.title', 'Agent API keys')}
      description={
        model.orcaCloudApiAvailable ? (
          <AgentApiKeysCloudDescription
            onOpenCloudSecrets={() => void actions.scrollToSection('cloud-secrets')}
          />
        ) : (
          t(
            'auto.components.settings.agentApiKeys.description',
            'Optional. Give an agent an API key on every host, or only some, instead of signing in on each machine.'
          )
        )
      }
      badge={t('auto.hooks.useSettingsNavigationMetadata.7c79d3b7bf', 'Optional')}
      searchEntries={navigation.getSectionSearchEntries('agent-api-keys')}
    >
      {view.isSectionMounted('agent-api-keys') ? <AgentApiKeysSection /> : null}
    </SettingsSection>
  ) : null
}
