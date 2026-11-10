import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { resolveWorktreeRowOpenInRuntimeOwner } from '@/lib/workspace/ownership/worktree-row-open-in-owner'
import {
  cloudAgentRowSignIn,
  cloudRowSignInAgent,
  isCloudRowSignInCandidate,
  type CloudAgentRowSignIn
} from '@/lib/orca-cloud/cloud-agent-row-sign-in'
import {
  ensureFreshOrcaCloudAgentAccounts,
  readOrcaCloudAgentAccounts,
  subscribeOrcaCloudAgentAccounts
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import {
  hostAgentSignInEntry,
  precheckHostAgentSignIn,
  readHostAgentSignInReport,
  subscribeHostAgentSignInReports
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'

const subscribeNothing = (): (() => void) => () => {}

function orcaCloudEnvironmentIdForWorktree(state: AppState, worktreeId: string): string | null {
  const worktree = findWorktreeById(state, worktreeId)
  if (!worktree) {
    return null
  }
  const environmentId = resolveWorktreeRowOpenInRuntimeOwner(state, worktree).runtimeEnvironmentId
  const environment = environmentId
    ? state.runtimeEnvironments?.find((entry) => entry.id === environmentId)
    : undefined
  return environment && isOrcaCloudRuntimeEnvironment(environment) ? environment.id : null
}

/**
 * Why a cloud agent row that never ran a turn is not "Done": its agent isn't signed in.
 * Null for local, SSH and paired hosts, and for any row that has finished a turn.
 */
export function useCloudAgentRowSignIn(
  agent: Pick<DashboardAgentRow, 'agentType' | 'entry' | 'tab' | 'childRow'>,
  dotState: AgentDotState
): CloudAgentRowSignIn | null {
  const candidate = isCloudRowSignInCandidate({
    agentType: agent.agentType,
    dotState,
    sessionBoundary: agent.entry.sessionBoundary,
    isChildRow: agent.childRow !== undefined
  })
  const worktreeId = agent.tab.worktreeId
  // Non-candidates skip the worktree lookup, so local rows pay nothing per store change.
  const environmentId = useAppStore((s) =>
    candidate ? orcaCloudEnvironmentIdForWorktree(s, worktreeId) : null
  )
  const accounts = useSyncExternalStore(
    environmentId ? subscribeOrcaCloudAgentAccounts : subscribeNothing,
    readOrcaCloudAgentAccounts,
    readOrcaCloudAgentAccounts
  )
  const report = useSyncExternalStore(
    environmentId ? subscribeHostAgentSignInReports : subscribeNothing,
    () => (environmentId ? readHostAgentSignInReport(environmentId) : null),
    () => null
  )
  useEffect(() => {
    if (!environmentId) {
      return
    }
    void ensureFreshOrcaCloudAgentAccounts().catch(() => undefined)
    precheckHostAgentSignIn(environmentId)
  }, [environmentId])
  const signInAgent = cloudRowSignInAgent(agent.agentType)
  if (!environmentId || !signInAgent) {
    return null
  }
  return cloudAgentRowSignIn(signInAgent, accounts, hostAgentSignInEntry(report, signInAgent))
}
