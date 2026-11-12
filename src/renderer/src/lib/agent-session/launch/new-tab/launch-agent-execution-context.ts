import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-args'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import type { AgentStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { launchHostIsRemote } from '../../../../../../shared/agent-launch/startup/agent-launch-remote'
import '@/lib/workspace/ownership/connection-context'
import {
  getConnectionIdFromState,
  getConnectionIdForWorktreeCopy
} from '@/lib/workspace/ownership/connection-owner-resolution'
import {
  refineLocalLaunchPlatform,
  resolveExecutionHostAgentStartupShell,
  resolveWorktreeExecutionHostPlatform
} from '@/runtime/hosts/platform/execution-host-facts'
import type { ExecutionHostPlatformFact } from '@/runtime/hosts/platform/execution-host-platform-fact'
import type { useAppStore } from '@/store/index'

export type AgentLaunchExecutionContext = {
  /** `undefined` means rival host rows disagree, which is not evidence of a remote. */
  worktreeSshConnectionId: string | null | undefined
  resolvedLaunchPlatform: NodeJS.Platform
  isRemote: boolean
  /** Only set for a local Windows launch; remote targets need their own shell signal. */
  queuedShell: AgentStartupShell | undefined
}

/** Scope the ordinary owner resolvers without changing the user's live selection. */
export function agentTabLaunchStore(
  store: ReturnType<typeof useAppStore.getState>,
  args: Pick<
    LaunchAgentInNewTabArgs,
    'worktreeId' | 'workspaceExecutionHostId' | 'selectedExecutionHostId'
  >
): ReturnType<typeof useAppStore.getState> {
  const executionHostId = args.selectedExecutionHostId ?? args.workspaceExecutionHostId
  return executionHostId
    ? {
        ...store,
        activeWorktreeId: args.worktreeId,
        activeWorkspaceExecutionHostId: executionHostId
      }
    : store
}

/** Preparation returns facts; the launch action owns failure presentation. */
export function resolveAgentLaunchExecutionContext(
  store: ReturnType<typeof useAppStore.getState>,
  args: Pick<
    LaunchAgentInNewTabArgs,
    'worktreeId' | 'launchPlatform' | 'workspaceExecutionHostId'
  > & { executionHostId?: ExecutionHostId }
):
  | AgentLaunchExecutionContext
  | { unavailable: Extract<ExecutionHostPlatformFact, { kind: 'withheld' }> } {
  const executionHostId = args.executionHostId ?? args.workspaceExecutionHostId
  // Why: `undefined` (rival host rows disagree) is not evidence of a remote; main rejects it anyway.
  const worktreeSshConnectionId = executionHostId
    ? getConnectionIdForWorktreeCopy(store, args.worktreeId, executionHostId)
    : getConnectionIdFromState(store, args.worktreeId)
  // Why getKnownWorktreeById: folder workspaces are not in allWorktrees, and their path marks WSL.
  const selectedWorktree = executionHostId
    ? selectWorkspaceByHostTarget(
        store,
        hostWorktreeTarget({ id: args.worktreeId, hostId: executionHostId })
      )
    : undefined
  const workspacePath = (
    selectedWorktree ??
    store.getKnownWorktreeById?.(args.worktreeId, executionHostId) ??
    (executionHostId
      ? undefined
      : store.allWorktrees?.().find((entry) => entry.id === args.worktreeId))
  )?.path
  // Why: the agent runs on the workspace's execution host, so its OS and shell decide quoting (#22204).
  const fact = resolveWorktreeExecutionHostPlatform(
    store,
    args.worktreeId,
    workspacePath,
    executionHostId
  )
  if (fact.kind === 'withheld') {
    return { unavailable: fact }
  }
  const launchHost = refineLocalLaunchPlatform(fact, args.launchPlatform)
  return {
    worktreeSshConnectionId,
    resolvedLaunchPlatform: launchHost.platform,
    isRemote: launchHostIsRemote(launchHost.hostKind, workspacePath),
    queuedShell: resolveExecutionHostAgentStartupShell(
      launchHost,
      store.settings?.terminalWindowsShell
    )
  }
}

export function agentTabLaunchRuntimeEnvironmentId(
  store: ReturnType<typeof useAppStore.getState>,
  args: Pick<LaunchAgentInNewTabArgs, 'worktreeId' | 'selectedExecutionHostId'>
) {
  const worktreeId = args.worktreeId
  const selectedOwner = args.selectedExecutionHostId
    ? runtimeEnvironmentIdForWorkspaceOwner(store, {
        workspaceId: worktreeId,
        hostId: args.selectedExecutionHostId
      })
    : undefined
  const runtimeEnvironmentId =
    selectedOwner?.kind === 'resolved'
      ? selectedOwner.environmentId
      : runtimeEnvironmentIdOrLocalUnlessTwin(store, worktreeId)
  return runtimeEnvironmentId
}
