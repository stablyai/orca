import { toast } from 'sonner'
import type { AgentSessionWorkspaceSleepResult } from '../../../../shared/agent-session-workspace-sleep'
import { useAppStore } from '@/store'
import {
  clearWorktreeSleepIntent,
  isCurrentWorktreeSleepIntent,
  markWorktreeSleepIntent,
  withWorktreeSleepTeardown
} from '@/lib/worktree-sleep-intent'
import { preserveSidebarWorktreePosition } from './sleep-worktree-sidebar-position'
import { describeChatStopFailure, describeSleepFailure } from './sleep-worktree-failure-copy'
import { translate } from '@/i18n/i18n'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { routeForOwner } from '@/lib/worktree-owner-route'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from '@/lib/worktree-runtime-owner-index'
import { getFolderWorkspaceHostId } from './folder-workspace-host-id'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'
import type { AppState } from '@/store/types'

export type WorkspaceSleepTarget =
  | string
  | {
      id: string
      repoId?: string
      executionHostId?: ExecutionHostId
      hostId?: ExecutionHostId
      runtimeOwnerEnvironmentId?: string
    }

export type WorkspaceSleepResult = {
  workspaceId: string
  executionHostId: ExecutionHostId
  stoppedSessionIds: string[]
  completed: boolean
}

/**
 * Shared "sleep worktree" flow (close all panels to free memory / CPU)
 * used by WorktreeContextMenu and MemoryStatusSegment's per-row hover action.
 *
 * Why this is a module helper rather than inlined at each call site: the guard
 * that clears `activeWorktreeId` before tearing down terminals isn't optional
 * polish — shutting down the active worktree while its TerminalPane is still
 * visible causes a visible "reboot" flicker and can crash the pane (PTY exit
 * callbacks race against the live xterm instance). See the original comment
 * in WorktreeContextMenu's handleCloseTerminals for the full reasoning.
 * Centralizing the sequence here keeps that safety invariant in one place so
 * a new caller can't accidentally skip it.
 */
export async function runSleepWorktree(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Promise<WorkspaceSleepResult[]> {
  return runSleepWorktrees([executionHostId ? { id: worktreeId, executionHostId } : worktreeId])
}

function resolveSleepTarget(
  state: AppState,
  target: WorkspaceSleepTarget
): { workspaceId: string; executionHostId: ExecutionHostId } | null {
  const workspaceId = typeof target === 'string' ? target : target.id
  const explicit = typeof target === 'string' ? undefined : target.executionHostId
  if (explicit) {
    const host = parseExecutionHostId(explicit)
    return host ? { workspaceId, executionHostId: host.id } : null
  }
  const ownerRoute = typeof target === 'string' ? null : routeForOwner(target)
  const selectedHost =
    parseExecutionHostId(ownerRoute?.executionHostId)?.id ??
    (ownerRoute?.runtimeEnvironmentId
      ? toRuntimeExecutionHostId(ownerRoute.runtimeEnvironmentId)
      : undefined)
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = findIndexedFolderWorkspaceOwner(
      state.folderWorkspaces,
      scope.folderWorkspaceId,
      selectedHost
    )
    if (!folder) {
      return null
    }
    const group =
      (selectedHost
        ? findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId, selectedHost)
        : null) ?? findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId)
    const executionHostId = getFolderWorkspaceHostId(
      folder,
      group ?? { connectionId: null, executionHostId: null },
      parseExecutionHostId(state.restoredRuntimeHostIdByWorkspaceSessionKey?.[workspaceId])?.id ??
        LOCAL_EXECUTION_HOST_ID
    )
    return { workspaceId, executionHostId }
  }
  if (selectedHost) {
    return { workspaceId, executionHostId: selectedHost }
  }
  const route = resolveWorktreeOperationRouteResult(state, workspaceId)
  return route.kind === 'resolved' && route.route.executionHostId
    ? { workspaceId, executionHostId: route.route.executionHostId }
    : null
}

export async function runSleepWorktrees(
  targets: readonly WorkspaceSleepTarget[]
): Promise<WorkspaceSleepResult[]> {
  const { errors, results } = await sleepWorktreesReportingFailures(targets, {
    recordExplicitChatSleep: true
  })
  if (errors.length > 0) {
    // Why: callers are fire-and-forget; surface actionable teardown failures after restoring retryable UI state.
    toast.error(
      targets.length === 1
        ? translate(
            'auto.components.sidebar.sleep.worktree.flow.8bc3fc0671',
            'Failed to sleep workspace'
          )
        : translate(
            'auto.components.sidebar.sleep.worktree.flow.c460fecc4a',
            'Failed to sleep some workspaces'
          ),
      { description: errors.join('\n') }
    )
  }
  return results
}

export type WorktreeSleepOutcome = {
  /** Every workspace this call did not verifiably sleep, including an unconfirmed chat stop. */
  failedWorktreeIds: string[]
  errors: string[]
  results: WorkspaceSleepResult[]
}

/** The sleep without the toast, for callers that report failures themselves. */
export async function sleepWorktreesReportingFailures(
  targets: readonly WorkspaceSleepTarget[],
  // Why: only the user's Sleep hides its chats; a project move pauses through this core too.
  options: { recordExplicitChatSleep?: boolean } = {}
): Promise<WorktreeSleepOutcome> {
  if (targets.length === 0) {
    return { failedWorktreeIds: [], errors: [], results: [] }
  }
  const state = useAppStore.getState()
  const errors: string[] = []
  const failedWorktreeIds = new Set<string>()
  const seen = new Set<string>()
  const resolved = targets.flatMap((target) => {
    const selected = resolveSleepTarget(state, target)
    if (!selected) {
      failedWorktreeIds.add(typeof target === 'string' ? target : target.id)
      errors.push(describeSleepFailure(new Error('workspace owner is unavailable')))
      return []
    }
    const key = `${selected.executionHostId}\0${selected.workspaceId}`
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [selected]
  })
  const capturedChats = resolved.map(({ workspaceId, executionHostId }) =>
    (state.unifiedTabsByWorktree[workspaceId] ?? [])
      .filter((tab) => isStructuredTab(tab) && tab.executionHostId === executionHostId)
      .map((tab) => ({ tabId: tab.id, sessionId: tab.entityId, executionHostId }))
  )
  const marked = resolved.map((target) => ({
    ...target,
    token: markWorktreeSleepIntent(target.workspaceId, target.executionHostId)
  }))
  const noNativeSessions: AgentSessionWorkspaceSleepResult = { stoppedSessionIds: [] }
  const nativeCalls = marked.map(({ workspaceId, executionHostId }) => {
    const nativeTarget = structuredAgentSessionTargetForHost(executionHostId)
    return nativeTarget
      ? callStructuredAgentSession<AgentSessionWorkspaceSleepResult>(
          nativeTarget,
          'agentSession.sleepWorkspace',
          { workspaceId }
        ).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error })
        )
      : Promise.resolve({ ok: true as const, value: noNativeSessions })
  })
  const activeRoute = state.activeWorktreeId
    ? resolveWorktreeOperationRouteResult(state, state.activeWorktreeId)
    : null
  const activeHost =
    state.activeWorkspaceExecutionHostId ??
    (activeRoute?.kind === 'resolved' ? activeRoute.route.executionHostId : null)
  const selected = marked.find(
    (target) =>
      state.activeWorktreeId === target.workspaceId && activeHost === target.executionHostId
  )
  if (selected) {
    const restoreSidebarPosition = preserveSidebarWorktreePosition(selected.workspaceId)
    state.setActiveWorktree(null)
    restoreSidebarPosition()
  }
  const attempts = await Promise.all(
    marked.map(async (target, index): Promise<WorkspaceSleepResult> => {
      const { workspaceId, executionHostId, token } = target
      const current = (): boolean =>
        isCurrentWorktreeSleepIntent(workspaceId, executionHostId, token)
      const clearFailedChats = (failures?: readonly { sessionId?: string }[]): void => {
        if (!options.recordExplicitChatSleep || !current()) {
          return
        }
        const failed = failures?.map((failure) => failure.sessionId)
        const chats =
          !failed || failed.includes(undefined)
            ? undefined
            : capturedChats[index].filter((chat) => failed.includes(chat.sessionId))
        useAppStore.getState().clearWorkspaceChatsSlept(workspaceId, executionHostId, chats)
      }
      let stoppedSessionIds: string[] = []
      let nativeCompleted = true
      let panelsCompleted = true
      let terminalsStopped = false
      const native = await nativeCalls[index]
      if (native.ok) {
        stoppedSessionIds = native.value.stoppedSessionIds
        if (native.value.failures?.length) {
          clearFailedChats(native.value.failures)
          console.error('[sleep-worktree] native chat stop incomplete', {
            workspaceId,
            failures: native.value.failures
          })
          nativeCompleted = false
          errors.push(describeChatStopFailure())
        }
      } else {
        clearFailedChats()
        console.error('[sleep-worktree] native chat stop failed', {
          workspaceId,
          error: native.error
        })
        nativeCompleted = false
        errors.push(describeChatStopFailure())
      }
      if (current()) {
        try {
          await state.shutdownWorktreeBrowsers(workspaceId)
        } catch (error) {
          console.error('[sleep-worktree] browser shutdown failed', { workspaceId, error })
          panelsCompleted = false
          errors.push(describeSleepFailure(error))
        }
      } else {
        panelsCompleted = false
      }
      if (current() && panelsCompleted) {
        try {
          await withWorktreeSleepTeardown(
            workspaceId,
            () => state.shutdownWorktreeTerminals(workspaceId, { keepIdentifiers: true }),
            executionHostId
          )
          terminalsStopped = true
        } catch (error) {
          console.error('[sleep-worktree] terminal shutdown failed', { workspaceId, error })
          panelsCompleted = false
          errors.push(describeSleepFailure(error))
        }
      }
      if (
        current() &&
        terminalsStopped &&
        typeof window !== 'undefined' &&
        window.api?.ephemeralVm?.suspendWorkspace
      ) {
        try {
          await window.api.ephemeralVm.suspendWorkspace({ workspaceId, executionHostId })
        } catch (error) {
          console.error('[sleep-worktree] host suspension failed', { workspaceId, error })
          panelsCompleted = false
          errors.push(describeSleepFailure(error))
        }
      }
      const completed = nativeCompleted && panelsCompleted && terminalsStopped && current()
      if (!completed && !terminalsStopped && current()) {
        clearWorktreeSleepIntent(workspaceId, executionHostId)
      }
      return { workspaceId, executionHostId, stoppedSessionIds, completed }
    })
  )
  const results = attempts.map((result, index) => {
    const completed =
      result.completed &&
      isCurrentWorktreeSleepIntent(result.workspaceId, result.executionHostId, marked[index].token)
    if (completed && options.recordExplicitChatSleep) {
      const stopped = new Set(result.stoppedSessionIds)
      const chats = capturedChats[index].filter((chat) => stopped.has(chat.sessionId))
      if (chats.length > 0) {
        useAppStore
          .getState()
          .markWorkspaceChatsSlept(result.workspaceId, result.executionHostId, chats)
      }
    }
    return { ...result, completed }
  })
  for (const result of results.filter((candidate) => !candidate.completed)) {
    failedWorktreeIds.add(result.workspaceId)
  }
  return { failedWorktreeIds: [...failedWorktreeIds], errors: [...new Set(errors)], results }
}
