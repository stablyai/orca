// After a cloud create whose agent has no Orca Cloud account: the workspace starts with a terminal
// (never the agent's /login) and this one toast is the only sign-in prompt (design-squad journey
// rule). It names the workspace once the user has moved to another one, and clears itself as soon
// as the agent's account turns active.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { openOrcaCloudAgentAccounts } from '@/components/new-workspace/OrcaCloudAgentSetupRow'
import { agentName } from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import type { OrcaCloudAccountAgent } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { orcaCloudAgentCoverageFromAccounts } from './orca-cloud-agent-accounts-model'
import {
  readOrcaCloudAgentAccounts,
  subscribeOrcaCloudAgentAccounts
} from './orca-cloud-agent-accounts-store'

const TOAST_ID = 'orca-cloud-agent-not-started'

let teardown: (() => void) | null = null

export function cloudAgentNotStartedMessage(agent: string, workspaceName: string | null): string {
  return workspaceName
    ? translate(
        'components.newWorkspace.cloudStart.agentNotStartedIn',
        '{{agent}} isn’t set up for Orca Cloud, so it didn’t start in {{workspace}}.',
        { agent, workspace: workspaceName }
      )
    : translate(
        'components.newWorkspace.cloudStart.agentNotStartedShort',
        '{{agent}} isn’t set up for Orca Cloud, so it didn’t start.',
        { agent }
      )
}

/** True once the agent signs in from the Orca account or a key covers it. */
export function isCloudAgentCovered(agent: OrcaCloudAccountAgent): boolean {
  const coverage = orcaCloudAgentCoverageFromAccounts(agent, readOrcaCloudAgentAccounts())
  return coverage?.kind === 'account' || coverage?.kind === 'key'
}

export function showCloudAgentNotStartedToast(
  agent: OrcaCloudAccountAgent,
  workspaceName: string
): void {
  teardown?.()
  const name = agentName(agent, translate)
  const render = (switchedAway: boolean): void => {
    toast.message(
      cloudAgentNotStartedMessage(
        name,
        switchedAway && workspaceName.trim() ? workspaceName : null
      ),
      {
        id: TOAST_ID,
        // Stays until the user acts on it or the account turns active.
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: translate(
            'components.newWorkspace.cloudStart.setUpAgentOnce',
            'Set up {{agent}} once',
            {
              agent: name
            }
          ),
          onClick: openOrcaCloudAgentAccounts
        },
        onDismiss: () => teardown?.()
      }
    )
  }
  render(false)

  // The create activates the new workspace (first change); any later change means the user moved.
  let createdOn: string | null | undefined
  let switchedAway = false
  const stopWorkspace = useAppStore.subscribe((state, previous) => {
    if (state.activeWorktreeId === previous.activeWorktreeId) {
      return
    }
    if (createdOn === undefined) {
      createdOn = state.activeWorktreeId ?? null
      return
    }
    const away = state.activeWorktreeId !== createdOn
    if (away !== switchedAway) {
      switchedAway = away
      render(away)
    }
  })
  const stopAccounts = subscribeOrcaCloudAgentAccounts(() => {
    if (isCloudAgentCovered(agent)) {
      toast.dismiss(TOAST_ID)
      teardown?.()
    }
  })
  teardown = () => {
    stopWorkspace()
    stopAccounts()
    teardown = null
  }
}
