import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { selectWorkspaceByHostTarget } from '@/store/workspace-record-selectors'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import { toast } from 'sonner'
import type { AgentStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { launchHostIsRemote } from '../../../../../../shared/agent-launch/startup/agent-launch-remote'
import '@/lib/connection-context'
import {
  getConnectionIdForWorktreeCopy,
  getConnectionIdFromState
} from '@/lib/connection-owner-resolution'
import {
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

/** `null` means the host's OS is unknown; the user has been told why the launch stopped. */
export function resolveAgentLaunchExecutionContext(
  store: ReturnType<typeof useAppStore.getState>,
  args: { worktreeId: string; launchPlatform?: NodeJS.Platform; executionHostId?: ExecutionHostId }
): AgentLaunchExecutionContext | null {
  // Why: `undefined` (rival host rows disagree) is not evidence of a remote; main rejects it anyway.
  const worktreeSshConnectionId = args.executionHostId
    ? getConnectionIdForWorktreeCopy(store, args.worktreeId, args.executionHostId)
    : getConnectionIdFromState(store, args.worktreeId)
  // Why getKnownWorktreeById: folder workspaces are not in allWorktrees, and their path marks WSL.
  const selectedWorktree = args.executionHostId
    ? selectWorkspaceByHostTarget(
        store,
        hostWorktreeTarget({ id: args.worktreeId, hostId: args.executionHostId })
      )
    : undefined
  const workspacePath = (
    selectedWorktree ??
    store.getKnownWorktreeById?.(args.worktreeId, args.executionHostId) ??
    (args.executionHostId
      ? undefined
      : store.allWorktrees?.().find((entry) => entry.id === args.worktreeId))
  )?.path
  // Why: the agent runs on the workspace's execution host, so its OS and shell decide quoting (#22204).
  const fact = resolveWorktreeExecutionHostPlatform(
    store,
    args.worktreeId,
    workspacePath,
    undefined,
    args.executionHostId
  )
  if (fact.kind === 'withheld') {
    toast.error(fact.reason)
    return null
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
