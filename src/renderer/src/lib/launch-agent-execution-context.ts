import { toast } from 'sonner'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  resolveExecutionHostAgentStartupShell,
  resolveWorktreeExecutionHostPlatform
} from '@/lib/execution-host-facts'
import type { useAppStore } from '@/store'

/** Where a new-tab agent launch runs, and the quoting rules that follow from it. */
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
  args: { worktreeId: string; launchPlatform?: NodeJS.Platform }
): AgentLaunchExecutionContext | null {
  // Why: `undefined` (rival host rows disagree) is not evidence of a remote; main rejects it anyway.
  const worktreeSshConnectionId = getConnectionIdFromState(store, args.worktreeId)
  // Why: SSH remotes deploy the shim as plain `orca`, so skip the Linux-only `orca-ide` rename for remote launches.
  const isRemote = Boolean(worktreeSshConnectionId)
  if (args.launchPlatform) {
    return {
      worktreeSshConnectionId,
      resolvedLaunchPlatform: args.launchPlatform,
      isRemote,
      queuedShell: resolveLocalWindowsAgentStartupShell({
        platform: args.launchPlatform,
        isRemote,
        terminalWindowsShell: store.settings?.terminalWindowsShell
      })
    }
  }
  const worktree = store.allWorktrees?.().find((entry) => entry.id === args.worktreeId)
  // Why: the agent runs on the workspace's execution host, so its OS and shell decide quoting (#22204).
  const fact = resolveWorktreeExecutionHostPlatform(store, args.worktreeId, worktree?.path)
  if (fact.kind === 'withheld') {
    toast.error(fact.reason)
    return null
  }
  return {
    worktreeSshConnectionId,
    resolvedLaunchPlatform: fact.platform,
    isRemote,
    queuedShell: resolveExecutionHostAgentStartupShell(fact, store.settings?.terminalWindowsShell)
  }
}
