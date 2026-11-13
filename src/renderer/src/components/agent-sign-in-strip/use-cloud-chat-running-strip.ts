// CHAT-BANNERS B2: RA-11's running strip for a structured chat on Orca Cloud. When the person's
// Orca-account sign-in expires while the chat's agent runs, the chat shows "sign-in expired · Renew";
// after Renew it confirms and dismisses. A structured chat needs no Restart: its next message goes out
// with the renewed sign-in.
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  HOST_AGENT_SIGN_IN_AGENT_NAME,
  type HostAgentSignInAgent
} from '../../../../shared/host-agent-sign-in-status'
import { chatCloudEnvironmentId } from './chat-cloud-environment'
import { useCloudAgentHold } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import {
  orcaCloudAgentAccountsLoadedAt,
  useOrcaCloudAgentAccounts
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import {
  clearCloudRunningSignout,
  cloudRunningStrip,
  type CloudRunningStrip,
  useCloudRunningAccountReads,
  useCloudRunningSignoutVersion,
  useWorkspaceUsesAccount
} from '@/lib/orca-cloud/cloud-running-agent-signout'
import type { CloudStripActions } from './CloudAgentSignInStrip'
import type { CloudHeldStrip } from './use-cloud-held-strip'
import { cloudChatRunningStripModel } from './cloud-running-strip-model'
import { openOrcaCloudAccountsSettings, withRenewInPlace } from './cloud-renew-in-place'

/** The Orca Cloud environment a structured chat's tab runs on (END-PASS CHAT-RENEW: shared rule). */
function useChatEnvironmentId(tabId: string): string | null {
  return useAppStore((state) => chatCloudEnvironmentId(state, tabId))
}

type ChatAccountArgs = {
  tabId: string
  statusKey: string
  holdKey: string
  /** The chat's own agent: an idle chat (no message yet) has no status entry to name it. */
  agent?: string
}

/**
 * The RA-11 decision for a structured chat: expired / renewed / none. An idle chat with no status
 * entry is decided from its own agent, so the strip shows as soon as the account expires, before a
 * first message could fail. A held launch wins (null here).
 */
export function useCloudChatAccountStrip(args: ChatAccountArgs): CloudRunningStrip | null {
  const revision = useCloudRunningSignoutVersion()
  const environmentId = useChatEnvironmentId(args.tabId)
  const cloud = environmentId !== null && isOrcaCloudEnvironmentId(environmentId)
  const status = useAppStore((state) =>
    cloud ? (state.agentStatusByPaneKey[args.statusKey] ?? null) : null
  )
  const agentType = status?.agentType ?? args.agent
  const agent: HostAgentSignInAgent | null =
    agentType === 'claude' ? 'claude' : agentType === 'codex' ? 'codex' : null
  const watched = cloud && agent !== null
  // Focus and the 30 s poll keep the account read fresh for any open cloud chat of an account agent.
  useCloudRunningAccountReads(watched)
  const accounts = useOrcaCloudAgentAccounts(watched)
  // D13: only a workspace that runs the agent on the person's own account (never shared or keyed).
  const credential =
    agent && accounts.load.kind === 'ready' ? accounts.load.status.credentials[agent] : null
  const expired =
    credential !== null &&
    credential.state !== 'active' &&
    credential.state !== 'expiring' &&
    credential.state !== 'none'
  const usesAccount = useWorkspaceUsesAccount(
    watched ? environmentId : null,
    agent,
    expired,
    orcaCloudAgentAccountsLoadedAt()
  )
  const held = useCloudAgentHold(args.holdKey) !== null
  if (!watched || !agent) {
    return null
  }
  return cloudRunningStrip({
    paneKey: args.statusKey,
    // An idle chat (no message yet) has no status entry: decided from its own agent.
    entry: status ?? { agentType: agent, state: 'waiting' },
    accounts,
    held,
    now: orcaCloudAgentAccountsLoadedAt(),
    usesAccount,
    revision,
    turnEndedFallback: true
  })
}

/** The strip a structured chat shows for its account while its agent runs or waits idle. */
export function useCloudChatRunningStrip(args: ChatAccountArgs): CloudHeldStrip | null {
  const t = useTranslate()
  const strip = useCloudChatAccountStrip(args)
  const accounts = useOrcaCloudAgentAccounts(strip !== null)
  if (!strip) {
    return null
  }
  const actions: CloudStripActions = {
    primary: (action) => (action.kind === 'renew' ? openOrcaCloudAccountsSettings() : undefined),
    submitCode: () => undefined,
    pasteCode: () => undefined,
    useCode: () => undefined,
    useApiKey: () => undefined,
    // Expired has no ×; renewed's × dismisses.
    cancel: () => (strip.phase === 'renewed' ? clearCloudRunningSignout(args.statusKey) : undefined)
  }
  const model = cloudChatRunningStripModel(strip, t)
  // CHAT-RENEW-INPLACE: the chat's "sign-in expired · Renew" renews right here.
  const shown =
    strip.phase === 'expired'
      ? withRenewInPlace({
          agent: strip.agent,
          setup: accounts.setups[strip.agent],
          model,
          actions,
          key: args.statusKey,
          t
        })
      : { model, actions }
  return { ...shown, prompt: null }
}

/**
 * While the chat's account is expired, typing stays open and only Send is held, with this hint
 * (the person's draft is never lost); Renew lifts it at once.
 */
export function useCloudChatSendBlock(args: ChatAccountArgs): string | undefined {
  const t = useTranslate()
  const strip = useCloudChatAccountStrip(args)
  return strip?.phase === 'expired'
    ? t('orcaCloud.chatSend.renewAbove', 'Renew {{agent}} sign-in above to send', {
        agent: HOST_AGENT_SIGN_IN_AGENT_NAME[strip.agent]
      })
    : undefined
}
