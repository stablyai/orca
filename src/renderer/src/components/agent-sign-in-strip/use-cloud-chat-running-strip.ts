// CHAT-BANNERS B2: RA-11's running strip for a structured chat on Orca Cloud. When the person's
// Orca-account sign-in expires while the chat's agent runs, the chat shows "sign-in expired · Renew";
// after Renew it confirms and dismisses. A structured chat needs no Restart: its next message goes out
// with the renewed sign-in.
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { useCloudAgentHold } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import {
  orcaCloudAgentAccountsLoadedAt,
  useOrcaCloudAgentAccounts
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import {
  clearCloudRunningSignout,
  cloudRunningStrip,
  useCloudRunningAccountReads,
  useCloudRunningSignoutVersion,
  useWorkspaceUsesAccount
} from '@/lib/orca-cloud/cloud-running-agent-signout'
import type { CloudStripActions } from './CloudAgentSignInStrip'
import type { CloudHeldStrip } from './use-cloud-held-strip'
import { cloudChatRunningStripModel } from './cloud-running-strip-model'

function openAccounts(): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'orca-cloud' })
  store.openSettingsPage()
}

/** The Orca Cloud environment a structured chat's tab runs on, or null. */
function useChatEnvironmentId(tabId: string): string | null {
  return useAppStore((state) => {
    for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
      const tab = tabs?.find((candidate) => candidate.id === tabId)
      if (tab) {
        const host = parseExecutionHostId(tab.executionHostId)
        return host?.kind === 'runtime' ? host.environmentId : null
      }
    }
    return null
  })
}

/**
 * statusKey: the chat's agent-status key (its tab and session); holdKey: its launch-hold key. A held
 * launch shows the held strip instead.
 */
export function useCloudChatRunningStrip(args: {
  tabId: string
  statusKey: string
  holdKey: string
}): CloudHeldStrip | null {
  const t = useTranslate()
  const revision = useCloudRunningSignoutVersion()
  const environmentId = useChatEnvironmentId(args.tabId)
  const cloud = environmentId !== null && isOrcaCloudEnvironmentId(environmentId)
  const entry = useAppStore((state) =>
    cloud ? (state.agentStatusByPaneKey[args.statusKey] ?? null) : null
  )
  const agent: HostAgentSignInAgent | null =
    entry?.agentType === 'claude' ? 'claude' : entry?.agentType === 'codex' ? 'codex' : null
  const running = cloud && agent !== null
  useCloudRunningAccountReads(running)
  const accounts = useOrcaCloudAgentAccounts(running)
  // D13: only a workspace that runs the agent on the person's own account (never shared or keyed).
  const credential =
    agent && accounts.load.kind === 'ready' ? accounts.load.status.credentials[agent] : null
  const expired =
    credential !== null &&
    credential.state !== 'active' &&
    credential.state !== 'expiring' &&
    credential.state !== 'none'
  const usesAccount = useWorkspaceUsesAccount(
    running ? environmentId : null,
    agent,
    expired,
    orcaCloudAgentAccountsLoadedAt()
  )
  const held = useCloudAgentHold(args.holdKey) !== null
  if (!running) {
    return null
  }
  const strip = cloudRunningStrip({
    paneKey: args.statusKey,
    entry,
    accounts,
    held,
    now: orcaCloudAgentAccountsLoadedAt(),
    usesAccount,
    revision,
    turnEndedFallback: true
  })
  if (!strip) {
    return null
  }
  const actions: CloudStripActions = {
    primary: (action) => (action.kind === 'renew' ? openAccounts() : undefined),
    submitCode: () => undefined,
    pasteCode: () => undefined,
    useCode: () => undefined,
    useApiKey: () => undefined,
    // Expired has no ×; renewed's × dismisses.
    cancel: () => (strip.phase === 'renewed' ? clearCloudRunningSignout(args.statusKey) : undefined)
  }
  return { model: cloudChatRunningStripModel(strip, t), prompt: null, actions }
}
