import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { resolveWorktreeRowOpenInRuntimeOwner } from '@/lib/workspace/ownership/worktree-row-open-in-owner'
import { useTranslate } from '@/i18n/use-translate'
import {
  cloudAgentRowSignIn,
  cloudAgentRowSignInLabel,
  cloudAgentRowSignInTooltip,
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
import { cloudAgentAccountActiveSince } from '@/lib/orca-cloud/cloud-agent-account-active-since'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
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
 * Why a cloud agent row at rest is not "Done" or "Idle": its agent isn't signed in.
 * Null for local, SSH and paired hosts, and for working or waiting rows.
 */
export function useCloudAgentRowSignIn(
  agent: Pick<DashboardAgentRow, 'agentType' | 'entry' | 'tab' | 'childRow'>,
  dotState: AgentDotState
): CloudAgentRowSignIn | null {
  const candidate = isCloudRowSignInCandidate({
    agentType: agent.agentType,
    dotState,
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
  return cloudAgentRowSignIn(signInAgent, accounts, hostAgentSignInEntry(report, signInAgent), {
    turnEndedAt: agent.entry.turnEndedAt,
    activeSince: cloudAgentAccountActiveSince(signInAgent)
  })
}

export type CloudAgentRowStatus = {
  dotState: AgentDotState
  label: string
  /** The catalog name ("Claude", "Codex"), never a terminal title such as "Claude Code". */
  agentName: string
  /** Null in send-target mode, which owns row clicks; otherwise the status links to Settings. */
  tooltip: string | null
}

/** What a sign-in-needed cloud row shows in place of its state: attention dot, label and link tooltip. */
export function useCloudAgentRowStatus(
  agent: Pick<DashboardAgentRow, 'agentType' | 'entry' | 'tab' | 'childRow'>,
  dotState: AgentDotState,
  /** Set while send-target mode owns row clicks. */
  sendTargetStatus: string | undefined
): CloudAgentRowStatus | null {
  const t = useTranslate()
  const signIn = useCloudAgentRowSignIn(agent, dotState)
  const signInAgent = cloudRowSignInAgent(agent.agentType)
  if (!signIn || !signInAgent) {
    return null
  }
  return {
    dotState: 'permission',
    label: cloudAgentRowSignInLabel(signIn, t),
    agentName: HOST_AGENT_SIGN_IN_AGENT_NAME[signInAgent],
    tooltip: sendTargetStatus ? null : cloudAgentRowSignInTooltip(signIn, t)
  }
}
