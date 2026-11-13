import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  captureAgentAccountRestartResumeInput,
  buildPaneAccountRestartStartup
} from '@/lib/agent-session/accounts/agent-account-restart-startup'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  currentCodexRestartPanes,
  eligibleCodexRestartPtyIds,
  isCodexAccountRestart,
  currentCodexAccountRestart
} from './codex-account-restart-continuation'
import type { CodexAccountRestart } from './terminal-contracts'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

export function createCodexAccountRestartActions(
  set: TerminalStoreSet
): Pick<
  TerminalSlice,
  'claimCodexAccountRestart' | 'updateCodexAccountRestart' | 'retryCodexAccountRestart'
> & { queueCodexAccountRestarts: (ptyIds: string[]) => void } {
  return {
    queueCodexAccountRestarts: (ptyIds) => {
      if (ptyIds.length === 0) {
        return
      }
      set((s) => {
        const next = { ...s.paneAccountRestarts }
        const notices = { ...s.codexRestartNoticeByPtyId }
        const panes = currentCodexRestartPanes(s)
        const eligible = panes ? new Set(eligibleCodexRestartPtyIds(s, panes)) : null
        for (const ptyId of new Set(ptyIds)) {
          const pane = panes?.get(ptyId)
          if (!pane || !eligible?.has(ptyId)) {
            continue
          }
          const existing = next[pane.key]
          if (isCodexAccountRestart(existing)) {
            continue
          }
          let startup: CodexAccountRestart['startup'] = null
          let startupInput: CodexAccountRestart['startupInput'] = null
          let error: string | undefined
          try {
            if (pane.leafId) {
              startupInput = captureAgentAccountRestartResumeInput('codex', {
                ...pane,
                leafId: pane.leafId
              })
              startup = structuredClone(
                buildPaneAccountRestartStartup(
                  'codex',
                  { ...pane, leafId: pane.leafId },
                  startupInput
                )
              )
            } else {
              error = 'terminal_pane_identity_unavailable'
            }
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
          }
          const environmentId = runtimeEnvironmentIdUnlessTwin(s, pane.worktreeId)
          const tab = s.tabsByWorktree[pane.worktreeId]?.find((t) => t.id === pane.tabId)
          next[pane.key] = {
            agent: 'codex',
            requestId: createBrowserUuid(),
            attemptId: createBrowserUuid(),
            worktreeId: pane.worktreeId,
            tabId: pane.tabId,
            tabCreatedAt: pane.tabCreatedAt,
            leafId: pane.leafId,
            oldPtyId: ptyId,
            oldIncarnationId: notices[ptyId]?.incarnationId,
            environmentId,
            ...(environmentId
              ? {
                  pairingRevision: getRuntimeEnvironmentRevision(environmentId),
                  runtimeId: lastVerifiedRuntimeStatus(
                    s.runtimeStatusByEnvironmentId.get(environmentId)
                  )?.runtimeId
                }
              : {}),
            cwd:
              tab?.startupCwd ??
              s.getKnownWorktreeById(
                pane.worktreeId,
                getExecutionHostIdForWorktree(s, pane.worktreeId)
              )?.path,
            connectionId: getConnectionIdFromState(s, pane.worktreeId),
            shellOverride: tab?.shellOverride,
            projectRuntime: getLocalProjectExecutionRuntimeContext(s, pane.worktreeId),
            hostId: getExecutionHostIdForWorktree(s, pane.worktreeId),
            phase: startup ? 'accepted' : 'failed',
            startupInput: startup ? null : startupInput,
            startup,
            ...(error ? { error } : {})
          }
          const notice = notices[ptyId]
          if (notice) {
            notices[ptyId] = { ...notice, restartRequested: true }
          }
        }
        return { paneAccountRestarts: next, codexRestartNoticeByPtyId: notices }
      })
    },
    claimCodexAccountRestart: (key) => {
      let claimed: CodexAccountRestart | null = null
      set((s) => {
        const candidate = s.paneAccountRestarts[key]
        if (!isCodexAccountRestart(candidate) || candidate.phase !== 'accepted') {
          return s
        }
        const token = {
          key,
          requestId: candidate.requestId,
          attemptId: candidate.attemptId,
          executorId: candidate.executorId
        }
        if (!currentCodexAccountRestart(s, token)) {
          return s
        }
        claimed = { ...candidate, phase: 'claimed', executorId: createBrowserUuid() }
        return { paneAccountRestarts: { ...s.paneAccountRestarts, [key]: claimed } }
      })
      return claimed
    },
    updateCodexAccountRestart: (token, patch) => {
      set((s) => {
        const request = currentCodexAccountRestart(s, token)
        if (!request) {
          return s
        }
        const next = { ...s.paneAccountRestarts }
        if (patch) {
          next[token.key] = {
            ...request,
            ...patch,
            ...(patch.phase === 'accepted'
              ? {
                  executorId: undefined,
                  ...(request.phase === 'deferred' ? { attemptId: createBrowserUuid() } : {})
                }
              : {})
          }
        } else {
          delete next[token.key]
        }
        if (
          (patch?.phase === 'failed' || patch?.phase === 'deferred') &&
          patch.condition?.expected.kind === 'empty' &&
          request.leafId
        ) {
          const layout = s.terminalLayoutsByTabId[request.tabId]
          if (layout?.ptyIdsByLeafId?.[request.leafId] === request.oldPtyId) {
            const bindings = { ...layout.ptyIdsByLeafId }
            delete bindings[request.leafId]
            const ids = (s.ptyIdsByTabId[request.tabId] ?? []).filter(
              (id) => id !== request.oldPtyId
            )
            return {
              paneAccountRestarts: next,
              terminalLayoutsByTabId: {
                ...s.terminalLayoutsByTabId,
                [request.tabId]: { ...layout, ptyIdsByLeafId: bindings }
              },
              ptyIdsByTabId: { ...s.ptyIdsByTabId, [request.tabId]: ids },
              tabsByWorktree: {
                ...s.tabsByWorktree,
                [request.worktreeId]: s.tabsByWorktree[request.worktreeId].map((tab) =>
                  tab.id === request.tabId && tab.ptyId === request.oldPtyId
                    ? { ...tab, ptyId: ids[0] ?? null }
                    : tab
                )
              }
            }
          }
        }
        return { paneAccountRestarts: next }
      })
    },
    retryCodexAccountRestart: (token) => {
      set((s) => {
        const request = currentCodexAccountRestart(s, token)
        if (!request || request.phase !== 'failed') {
          return s
        }
        let nextRequest = request
        let key = token.key
        if (!request.leafId || !request.startup) {
          const pane = currentCodexRestartPanes(s).get(request.oldPtyId)
          if (!pane?.leafId) {
            return s
          }
          const startup = structuredClone(
            buildPaneAccountRestartStartup(
              'codex',
              { ...pane, leafId: pane.leafId },
              request.startupInput
            )
          )
          if (!startup) {
            return s
          }
          key = pane.key
          nextRequest = { ...request, leafId: pane.leafId, startup }
        }
        const next = { ...s.paneAccountRestarts }
        delete next[token.key]
        next[key] = {
          ...nextRequest,
          phase: 'accepted',
          attemptId: createBrowserUuid(),
          executorId: undefined,
          resultPtyId: undefined
        }
        return { paneAccountRestarts: next }
      })
    }
  }
}
