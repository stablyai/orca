import type { AgentAccountsPart } from '../accounts/AgentAccountsSubsection'
import { CloudAgentSignInsLinkRow } from '../agent-accounts/CloudAgentSignInsLinkRow'
import { AgentAccountsOverviewSection } from '../agent-accounts/overview/AgentAccountsOverviewSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

/** Settings → Agent accounts, after "This computer": Hosts. The page titles each part and
 *  lists it in its jump row. Orca Cloud's own sign-ins are Settings › Orca Cloud › Cloud agent
 *  sign-ins; see orcaCloudAgentAccountsLead. Desktop only, and only in builds with an Orca Cloud
 *  control plane. */
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
    }
  ]
}

/** The one row Agent accounts keeps for Orca Cloud: a link to Cloud agent sign-ins. */
export function orcaCloudAgentAccountsLead(context: SettingsRenderContext): React.ReactNode {
  const { model, actions } = context
  if (!model.showDesktopOnlySettings || !model.orcaCloudApiAvailable) {
    return null
  }
  return (
    <CloudAgentSignInsLinkRow onOpen={() => void actions.scrollToSection('cloud-agent-sign-ins')} />
  )
}
