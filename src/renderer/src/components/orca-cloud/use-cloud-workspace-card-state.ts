// Card state that outlives one open card: whether Details is open (kept for the app session, for
// every cloud workspace alike), and the one attention row derived from the stores that know.
import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useCloudSecretsMissing } from '@/lib/orca-cloud/cloud-secrets-missing-notice-store'
import { cloudAgentHoldTabId } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { agentName } from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudSecretsAsk } from '../cloud-secrets-ask/CloudSecretsMissingNotice'
import { useWorktreeCloudAgentHold } from './CloudAgentHeldMark'
import { useWorkspaceAgentSignIn } from './use-cloud-agent-row-sign-in'
import {
  mostUrgentAttention,
  signInAttention,
  type CloudCardAttention
} from './cloud-workspace-card-model'

let detailsOpen = false
const listeners = new Set<() => void>()

export function setCloudCardDetailsOpen(open: boolean): void {
  detailsOpen = open
  for (const listener of listeners) {
    listener()
  }
}

export function useCloudCardDetailsOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => detailsOpen,
    () => false
  )
}

export function useCloudCardAttention(workspaceId: string): CloudCardAttention | null {
  const t = useTranslate()
  const hold = useWorktreeCloudAgentHold(workspaceId)
  const secrets = useCloudSecretsMissing(workspaceId)
  // A running agent whose sign-in lapsed (the row's "Sign-in expired" / "Needs sign-in").
  const signIn = useWorkspaceAgentSignIn(workspaceId)
  return mostUrgentAttention([
    hold
      ? {
          kind: hold.reason === 'accountExpired' ? 'agentExpired' : 'agentNotSetUp',
          agent: agentName(hold.agent, t),
          tabId: cloudAgentHoldTabId(hold.paneKey)
        }
      : null,
    signInAttention(
      signIn
        ? { signIn: signIn.signIn, tabId: signIn.tabId, agentName: agentName(signIn.agent, t) }
        : null
    ),
    secrets && secrets.names.length > 0
      ? { kind: 'secretsMissing', count: secrets.names.length }
      : null
  ])
}

/** Where each attention row leads: the held pane's strip, or the missing-secrets form. */
export function openCloudCardAttention(workspaceId: string, item: CloudCardAttention): void {
  switch (item.kind) {
    case 'agentNotSetUp':
    case 'agentExpired':
      activateAndRevealWorktree(workspaceId)
      useAppStore.getState().setActiveTab(item.tabId)
      return
    case 'secretsMissing':
      openCloudSecretsAsk(workspaceId)
  }
}
