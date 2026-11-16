import {
  OrcaCloudEnvironmentsPane,
  OrcaCloudLocalCommandsSettingsPane,
  OrcaCloudMcpPane,
  OrcaCloudSecretsPane,
  OrcaCloudSkillsSyncPane,
  OrcaCloudWorkspacesPane
} from '../orca-cloud/OrcaCloudSettingsPanes'
import { OrcaCloudAccountsSection } from '../agent-accounts/OrcaCloudAccountsSection'
import { OrcaCloudAccountsDescription } from '../agent-accounts/OrcaCloudAccountsDescription'
import { CloudConsoleLinkRow } from '../orca-cloud/CloudConsoleLinkRow'
import { SettingsSection } from '../section-layout/SettingsSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

/** Settings › Orca Cloud: the account-backed panes. */
export function renderOrcaCloudSettingsSections(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  if (!model.showDesktopOnlySettings || !model.orcaCloudApiAvailable) {
    return null
  }
  // Titles and descriptions come from the nav metadata so the pane and the sidebar never disagree.
  const sections: {
    id: string
    pane: React.JSX.Element
    navOnly?: boolean
    /** Replaces the nav's plain-text description on the page. */
    description?: React.ReactNode
  }[] = [
    // S0, moved here from Settings › Agent accounts (which keeps a link row to this page).
    {
      id: 'cloud-agent-sign-ins',
      pane: <OrcaCloudAccountsSection hideHeader />,
      description: <OrcaCloudAccountsDescription />
    },
    // Listed in the nav for team owners and admins only; without the entry there is no page.
    { id: 'cloud-workspaces', pane: <OrcaCloudWorkspacesPane />, navOnly: true },
    { id: 'cloud-secrets', pane: <OrcaCloudSecretsPane /> },
    { id: 'cloud-skills', pane: <OrcaCloudSkillsSyncPane /> },
    { id: 'cloud-environments', pane: <OrcaCloudEnvironmentsPane /> },
    { id: 'cloud-mcp', pane: <OrcaCloudMcpPane /> },
    { id: 'cloud-local-commands', pane: <OrcaCloudLocalCommandsSettingsPane /> },
    // Managed in the web console; the desktop keeps one row that opens it.
    {
      id: 'cloud-api-keys',
      pane: (
        <CloudConsoleLinkRow
          section="api"
          label={t('settings.cloudConsole.api.title', 'API keys & connected apps')}
          description={t(
            'settings.cloudConsole.api.description',
            'Create and revoke keys, and disconnect apps.'
          )}
        />
      )
    }
  ]
  return (
    <>
      {sections.map(({ id, pane, navOnly, description }) => {
        const meta = navigation.navSections.find((section) => section.id === id)
        if (navOnly && !meta) {
          return null
        }
        return (
          <SettingsSection
            key={id}
            id={id}
            title={meta?.title ?? t('settings.breadcrumb.settings', 'Settings')}
            description={description ?? meta?.description ?? ''}
            searchEntries={navigation.getSectionSearchEntries(id)}
          >
            {view.isSectionMounted(id) ? pane : null}
          </SettingsSection>
        )
      })}
    </>
  )
}
