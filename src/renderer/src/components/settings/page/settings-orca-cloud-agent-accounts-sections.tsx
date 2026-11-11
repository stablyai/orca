import type { AgentAccountsPart } from '../accounts/AgentAccountsSubsection'
import { OrcaCloudAccountsSection } from '../agent-accounts/OrcaCloudAccountsSection'
import { OrcaCloudAccountsDescription } from '../agent-accounts/OrcaCloudAccountsDescription'
import { AgentAccountsOverviewSection } from '../agent-accounts/overview/AgentAccountsOverviewSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

/** Settings → Agent accounts, after "This computer": Hosts (S3) and Orca Cloud (S0). The page
 *  titles each part and lists it in its jump row. Desktop only, and only in builds with an Orca
 *  Cloud control plane. */
export function orcaCloudAgentAccountsParts(
  context: SettingsRenderContext,
  t: Translate = translate
): AgentAccountsPart[] {
  const { model } = context
  if (!model.showDesktopOnlySettings || !model.orcaCloudApiAvailable) {
    return []
  }
  return [
    {
      id: 'accounts-hosts',
      title: t('settings.agentAccounts.hostsTitle', 'Hosts'),
      description: t(
        'agentAccountsOverview.description',
        'Where Claude and Codex are signed in, and which key they use. Orca never copies a sign-in between machines.'
      ),
      content: <AgentAccountsOverviewSection hideHeader />
    },
    {
      id: 'accounts-orca-cloud',
      title: t('orcaCloudAccounts.title', 'Orca Cloud'),
      description: <OrcaCloudAccountsDescription />,
      content: <OrcaCloudAccountsSection hideHeader />
    }
  ]
}
