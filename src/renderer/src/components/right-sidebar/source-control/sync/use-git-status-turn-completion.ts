import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getStructuredAgentSessionTurnCompletionFeed } from '@/runtime/native-chat/status/structured-agent-session-turn-completion-feed'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getPtyIdForPaneKey } from '@/hooks/pane-key-pty-id'
import { isWindowVisible } from '@/lib/window-activity/window-visibility-interval'
import { mainAgentDoneAt } from '../../../../../../shared/agent-status/lifecycle/main-agent-status'
import {
  type ExecutionHostId,
  getConnectionExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { parseAppSshPtyId } from '../../../../../../shared/ssh-pty-id'
import type { AgentStatusChange } from '@/store/slices/agent-status/agent-status-contract'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { GitStatusRefreshScheduler } from './git-status-refresh-scheduler'

export function isNewTerminalTurnEnd({ previous, current }: AgentStatusChange): boolean {
  if (
    !current ||
    current.structuredHostOwned ||
    current.sessionBoundary ||
    current.restoredUnconfirmed
  ) {
    return false
  }
  if (current.turnEndedAt !== undefined && current.turnEndedAt !== previous?.turnEndedAt) {
    return true
  }
  return (
    previous !== undefined &&
    mainAgentDoneAt(current) !== undefined &&
    mainAgentDoneAt(current) !== mainAgentDoneAt(previous)
  )
}

export function useGitStatusTurnCompletion(
  target: RuntimeClientTarget | null,
  expectedHost: ExecutionHostId,
  worktreeId: string | null,
  enabled: boolean,
  scheduler: { readonly current: GitStatusRefreshScheduler | null }
): void {
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Visibility releases all subscriptions; effect cleanup releases the remaining visible lease.
  useEffect(() => {
    if (!worktreeId || !enabled) {
      return
    }
    let releaseVisible: (() => void) | undefined
    const reconcile = (): void => {
      if (!isWindowVisible()) {
        releaseVisible?.()
        releaseVisible = undefined
        return
      }
      if (releaseVisible) {
        return
      }
      const feed = target ? getStructuredAgentSessionTurnCompletionFeed(target) : null
      const stopFeed = feed?.subscribe((edge) => {
        if (edge.type !== 'completion' || !isWindowVisible()) {
          return
        }
        const { scope, sessionId } = edge.completion
        if (scope.executionHostId !== expectedHost) {
          return
        }
        const tabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
        if (
          scope.workspaceId === worktreeId ||
          tabs.some((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)
        ) {
          scheduler.current?.signal()
        }
      })
      const releaseFeed = feed?.activate()
      const stopTerminal = useAppStore.getState().subscribeAgentStatusChanges((changes) => {
        if (!isWindowVisible()) {
          return
        }
        for (const change of changes) {
          if (!isNewTerminalTurnEnd(change)) {
            continue
          }
          const row = change.current!
          if (row.worktreeId !== undefined && row.worktreeId !== worktreeId) {
            continue
          }
          const tabId = parsePaneKey(change.paneKey)?.tabId
          const tabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
          const tab = tabs.find(
            (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
          )
          if (row.worktreeId !== worktreeId && !tab) {
            continue
          }
          const ptyId = getPtyIdForPaneKey(change.paneKey) ?? ''
          const runtimeId = parseRemoteRuntimePtyId(ptyId)?.environmentId
          const ssh = parseAppSshPtyId(ptyId)
          const host =
            tab?.executionHostId ??
            (runtimeId
              ? toRuntimeExecutionHostId(runtimeId)
              : ssh
                ? toSshExecutionHostId(ssh.connectionId)
                : isRemoteRuntimePtyId(ptyId) || ptyId.startsWith('ssh:')
                  ? null
                  : row.connectionId !== undefined || ptyId
                    ? getConnectionExecutionHostId(row.connectionId)
                    : null)
          if (host === expectedHost) {
            scheduler.current?.signal()
            break
          }
        }
      })
      releaseVisible = () => {
        stopTerminal()
        stopFeed?.()
        releaseFeed?.()
      }
    }
    reconcile()
    document.addEventListener('visibilitychange', reconcile)
    return () => {
      document.removeEventListener('visibilitychange', reconcile)
      releaseVisible?.()
    }
  }, [target, expectedHost, worktreeId, enabled, scheduler])
}
