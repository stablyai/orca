import { CloudApiKeysPane } from '../cloud-api/CloudApiKeysPane'
import { CloudRoutinesPane } from '../cloud-api/CloudRoutinesPane'
import { SettingsSection } from '../section-layout/SettingsSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

// Orca Cloud programmatic access; only builds with a control plane (private/hosted) show these.
export function renderCloudApiSettingsSections(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  if (!model.showDesktopOnlySettings || !model.orcaCloudApiAvailable) {
    return null
  }
  return (
    <>
      <SettingsSection
        id="cloud-api-keys"
        title={t('auto.components.settings.cloudApi.sectionTitle', 'Orca API keys')}
        badge="Beta"
        description={t(
          'auto.components.settings.cloudApi.sectionDescription',
          'For the Orca Cloud API, the orca CLI and MCP clients. Claude or Codex keys go in Cloud secrets.'
        )}
        searchEntries={navigation.getSectionSearchEntries('cloud-api-keys')}
        bodyClassName="rounded-none border-0 bg-transparent p-0 shadow-none"
      >
        {view.isSectionMounted('cloud-api-keys') ? <CloudApiKeysPane /> : null}
      </SettingsSection>
      <SettingsSection
        id="cloud-routines"
        title={t('auto.components.settings.cloudRoutines.sectionTitle', 'Routines')}
        badge="Beta"
        description={t(
          'auto.components.settings.cloudRoutines.sectionDescription',
          'Agents that run in Orca Cloud on a schedule, on GitHub events or from a webhook.'
        )}
        searchEntries={navigation.getSectionSearchEntries('cloud-routines')}
        bodyClassName="rounded-none border-0 bg-transparent p-0 shadow-none"
      >
        {view.isSectionMounted('cloud-routines') ? <CloudRoutinesPane /> : null}
      </SettingsSection>
    </>
  )
}
