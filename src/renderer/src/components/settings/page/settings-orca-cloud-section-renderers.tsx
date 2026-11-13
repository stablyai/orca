import {
  OrcaCloudEnterprisePane,
  OrcaCloudEnvironmentsPane,
  OrcaCloudLocalCommandsSettingsPane,
  OrcaCloudMcpPane,
  OrcaCloudSecretsPane,
  OrcaCloudSkillsSyncPane,
  OrcaCloudTeamPane,
  OrcaCloudWorkspacesPane
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
  const sections: { id: string; pane: React.JSX.Element; navOnly?: boolean }[] = [
    { id: 'cloud-team', pane: <OrcaCloudTeamPane /> },
    // Listed in the nav for team owners and admins only; without the entry there is no page.
    { id: 'cloud-workspaces', pane: <OrcaCloudWorkspacesPane />, navOnly: true },
    { id: 'cloud-enterprise', pane: <OrcaCloudEnterprisePane />, navOnly: true },
    { id: 'cloud-secrets', pane: <OrcaCloudSecretsPane /> },
    { id: 'cloud-skills', pane: <OrcaCloudSkillsSyncPane /> },
    { id: 'cloud-environments', pane: <OrcaCloudEnvironmentsPane /> },
    { id: 'cloud-mcp', pane: <OrcaCloudMcpPane /> },
    { id: 'cloud-local-commands', pane: <OrcaCloudLocalCommandsSettingsPane /> }
  ]
  return (
    <>
      {sections.map(({ id, pane, navOnly }) => {
        const meta = navigation.navSections.find((section) => section.id === id)
        if (navOnly && !meta) {
          return null
        }
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
