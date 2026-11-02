import type { TerminalResidentIdentity } from './terminal-resident-registry'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NotificationWorkspaceOwner } from '../../../../shared/notification-source'
import type { PtyPaneStartup, PtyConnectionDeps } from './pty-connection-types'
import { useAppStore } from '@/store'
import { resolveWorkspaceDirectory } from '@/lib/workspace-directory'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { resolveTerminalNotificationOwner } from '@/attention/notification-subject-owner'

export type TerminalResidentServices = Pick<
  PtyConnectionDeps,
  'setCacheTimerStartedAt' | 'markTerminalBell' | 'dispatchNotification'
>

export type TerminalResidentBinding = {
  paneKey: string
  worktreeId: string
  tabId: string
  cwd?: string
  startup?: PtyPaneStartup
  initialTitle?: string
  workspaceOwner?: NotificationWorkspaceOwner
  launchToken?: string
  runtimeEnvironmentId?: string | null
}

export type TerminalResidentPresentation = {
  paneId: number
  isVisible: () => boolean
  showTitle: (title: string, rawTitle: string, staleWorkingTitleClear?: boolean) => void
  resetInputModes: () => void
  confirmedShell?: () => void
  preservesSleepingRecord?: (record: unknown, ptyId: string | null) => boolean
  setFocusReportSuppression: (title: string | undefined, agentType: AgentType | undefined) => void
  markBracketedPasteInterrupted: () => void
  onAgentExited: () => void
  setMode2031: (subscribed: boolean) => void
  clearFocusReportSuppression: () => void
}

/** Resolve no-view metadata through the same host-scoped catalog used by mounted workspaces. */
export function resolveTerminalResidentBinding(options: {
  ptyId: string
  paneKey: string
  tabId: string
  worktreeId: string
  connectionId?: string | null
  binding?: Partial<TerminalResidentBinding>
}): TerminalResidentBinding {
  const { binding, ptyId, paneKey, tabId, worktreeId } = options
  const state = useAppStore.getState()
  const paired = parseRemoteRuntimePtyId(ptyId)
  const executionHostId = options.connectionId
    ? toSshExecutionHostId(options.connectionId)
    : (binding?.workspaceOwner?.executionHostId ??
      parseExecutionHostId(getPtyExecutionHost(ptyId))?.id ??
      null)
  const runtimeEnvironmentId = paired?.environmentId ?? binding?.runtimeEnvironmentId ?? null
  return {
    ...binding,
    paneKey,
    tabId,
    worktreeId,
    cwd:
      binding?.cwd ||
      resolveWorkspaceDirectory(useAppStore.getState(), worktreeId, executionHostId) ||
      '',
    runtimeEnvironmentId,
    workspaceOwner: binding?.workspaceOwner ??
      resolveTerminalNotificationOwner(state, worktreeId, { paneKey, ptyId }) ?? {
        executionHostId,
        runtimeEnvironmentId
      }
  }
}

export function resolveInitialTerminalResidentOwner(
  binding: TerminalResidentBinding,
  initialIdentity: Readonly<TerminalResidentIdentity> | null
): NotificationWorkspaceOwner | undefined {
  return (
    binding.workspaceOwner ??
    (initialIdentity
      ? (resolveTerminalNotificationOwner(useAppStore.getState(), binding.worktreeId, {
          paneKey: binding.paneKey,
          ptyId: initialIdentity.ptyId
        }) ?? undefined)
      : undefined)
  )
}
