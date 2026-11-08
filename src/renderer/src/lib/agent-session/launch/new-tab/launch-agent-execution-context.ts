import type { AgentStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { launchHostIsRemote } from '../../../../../../shared/agent-launch/startup/agent-launch-remote'
import '@/lib/connection-context'
import {
  getConnectionIdFromState,
  getConnectionIdForWorktreeCopy
} from '@/lib/connection-owner-resolution'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-args'
import {
  type ExecutionHostPlatformFact,
  refineLocalLaunchPlatform,
  resolveExecutionHostAgentStartupShell,
  resolveWorktreeExecutionHostPlatform
} from '@/lib/execution-host-facts'
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
  args: Pick<LaunchAgentInNewTabArgs, 'worktreeId' | 'workspaceExecutionHostId'>
): ReturnType<typeof useAppStore.getState> {
  return args.workspaceExecutionHostId
    ? {
        ...store,
        activeWorktreeId: args.worktreeId,
        activeWorkspaceExecutionHostId: args.workspaceExecutionHostId
      }
    : store
}

/** Preparation returns facts; the launch action owns failure presentation. */
export function resolveAgentLaunchExecutionContext(
  store: ReturnType<typeof useAppStore.getState>,
  args: Pick<LaunchAgentInNewTabArgs, 'worktreeId' | 'launchPlatform' | 'workspaceExecutionHostId'>
):
  | AgentLaunchExecutionContext
  | { unavailable: Extract<ExecutionHostPlatformFact, { kind: 'withheld' }> } {
  // Why: `undefined` (rival host rows disagree) is not evidence of a remote; main rejects it anyway.
  const worktreeSshConnectionId = args.workspaceExecutionHostId
    ? getConnectionIdForWorktreeCopy(store, args.worktreeId, args.workspaceExecutionHostId)
    : getConnectionIdFromState(store, args.worktreeId)
  // Why getKnownWorktreeById: folder workspaces are not in allWorktrees, and their path marks WSL.
  const workspacePath = (
    store.getKnownWorktreeById?.(args.worktreeId, args.workspaceExecutionHostId) ??
    store.allWorktrees?.().find((entry) => entry.id === args.worktreeId)
  )?.path
  // Why: the agent runs on the workspace's execution host, so its OS and shell decide quoting (#22204).
  const fact = resolveWorktreeExecutionHostPlatform(
    store,
    args.worktreeId,
    workspacePath,
    args.workspaceExecutionHostId
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
