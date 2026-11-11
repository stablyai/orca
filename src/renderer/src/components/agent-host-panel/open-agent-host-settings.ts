// The panel's footer links and row actions open Settings over it; the panel closes first so focus
// lands in Settings rather than behind the sheet.
import { useAppStore } from '@/store'
import { openOrcaCloudSignInSheet } from '@/components/settings/agent-accounts/sign-in-sheet/orca-cloud-sign-in-sheet-store'
import type { AgentHostFooterLink } from './agent-host-capabilities'
import { closeAgentHostPanel } from './agent-host-panel-store'

const TARGET = {
  accounts: { pane: 'accounts' },
  agentAccounts: { pane: 'accounts', sectionId: 'orca-cloud' },
  agentApiKeys: { pane: 'agent-api-keys' },
  cloudSecrets: { pane: 'cloud-secrets' },
  customEnvironments: { pane: 'servers' },
  // S3 (Settings › Agent accounts) is the overview across hosts.
  allHosts: { pane: 'accounts', sectionId: 'accounts-hosts' }
} as const satisfies Record<AgentHostFooterLink, { pane: string; sectionId?: string }>

export function openAgentHostSettings(link: AgentHostFooterLink): void {
  closeAgentHostPanel()
  if (link === 'agentAccounts') {
    openOrcaCloudSignInSheet()
    return
  }
  const target: { pane: (typeof TARGET)[AgentHostFooterLink]['pane']; sectionId?: string } =
    TARGET[link]
  const store = useAppStore.getState()
  store.openSettingsTarget({
    pane: target.pane,
    repoId: null,
    ...(target.sectionId ? { sectionId: target.sectionId } : {})
  })
  store.openSettingsPage()
}
