import { AgentAccountsSubsection } from '../accounts/AgentAccountsSubsection'
import { OrcaCloudAccountsSection } from '../agent-accounts/OrcaCloudAccountsSection'
import { AgentAccountsOverviewSection } from '../agent-accounts/overview/AgentAccountsOverviewSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

/** Settings → Agent accounts, after "This computer": Hosts (S3) and Orca Cloud (S0). Desktop only,
 *  and only in builds with an Orca Cloud control plane. */
export function renderOrcaCloudAgentAccountsSections(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model } = context
  if (!model.showDesktopOnlySettings || !model.orcaCloudApiAvailable) {
    return null
  }
  return (
    <>
      <AgentAccountsSubsection
        id="accounts-hosts"
        title={t('settings.agentAccounts.hostsTitle', 'Hosts')}
        description={t(
          'agentAccountsOverview.description',
          'Where Claude and Codex are signed in, and which key they use. Orca never copies a sign-in between machines.'
        )}
      >
        <AgentAccountsOverviewSection hideHeader />
      </AgentAccountsSubsection>
      <AgentAccountsSubsection
        id="accounts-orca-cloud"
        title={t('orcaCloudAccounts.title', 'Orca Cloud')}
        description={t(
          'orcaCloudAccounts.help',
          'Set up once on this computer. Every cloud workspace uses it, including new, cloned and restarted ones.'
        )}
      >
        <OrcaCloudAccountsSection hideHeader />
      </AgentAccountsSubsection>
    </>
  )
}
