import {
  OrcaCloudBillingPane,
  OrcaCloudEnvironmentsPane,
  OrcaCloudMcpPane,
  OrcaCloudSecretsPane,
  OrcaCloudSkillsSyncPane,
  OrcaCloudTeamPane
} from '../orca-cloud/OrcaCloudSettingsPanes'
import { SettingsSection } from '../section-layout/SettingsSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

const BARE_BODY = 'rounded-none border-0 bg-transparent p-0 shadow-none'

/** Settings › Orca Cloud: the account-backed panes. Orca API keys and Routines follow them. */
export function renderOrcaCloudSettingsSections(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  if (!model.showDesktopOnlySettings || !model.orcaCloudApiAvailable) {
    return null
  }
  // Titles and descriptions come from the nav metadata so the pane and the sidebar never disagree.
  const sections = [
    { id: 'cloud-billing', pane: <OrcaCloudBillingPane /> },
    { id: 'cloud-team', pane: <OrcaCloudTeamPane /> },
    { id: 'cloud-secrets', pane: <OrcaCloudSecretsPane /> },
    { id: 'cloud-skills', pane: <OrcaCloudSkillsSyncPane /> },
    { id: 'cloud-environments', pane: <OrcaCloudEnvironmentsPane /> },
    { id: 'cloud-mcp', pane: <OrcaCloudMcpPane /> }
  ]
  return (
    <>
      {sections.map(({ id, pane }) => {
        const meta = navigation.navSections.find((section) => section.id === id)
        return (
          <SettingsSection
            key={id}
            id={id}
            title={meta?.title ?? t('settings.breadcrumb.settings', 'Settings')}
            description={meta?.description ?? ''}
            searchEntries={navigation.getSectionSearchEntries(id)}
            bodyClassName={BARE_BODY}
          >
            {view.isSectionMounted(id) ? pane : null}
          </SettingsSection>
        )
      })}
    </>
  )
}
