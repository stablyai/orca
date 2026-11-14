import { getTerminalNoticeLifetime } from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
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
import { getResourceExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  currentCodexRestartPanes,
  eligibleCodexRestartPtyIds,
  isCodexAccountRestart,
  currentCodexAccountRestart
} from './codex-account-restart-continuation'
import type { CodexAccountRestart } from './terminal-contracts'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createCodexAccountRestartActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
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
              startupInput = captureAgentAccountRestartResumeInput(s, 'codex', {
                ...pane,
                leafId: pane.leafId
              })
              startup = structuredClone(
                buildPaneAccountRestartStartup(
                  s,
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
            oldIncarnationId:
              notices[ptyId]?.incarnationId ?? getTerminalNoticeLifetime(ptyId)?.incarnationId,
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
                getResourceExecutionHostIdForWorktree(s, pane.worktreeId)
              )?.path,
            connectionId: getConnectionIdFromState(s, pane.worktreeId),
            shellOverride: tab?.shellOverride,
            projectRuntime: getLocalProjectExecutionRuntimeContext(s, pane.worktreeId),
            hostId: getResourceExecutionHostIdForWorktree(s, pane.worktreeId),
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
        const oldIncarnationId =
          request.oldIncarnationId ??
          (request.condition?.expected.kind === 'endpoint'
            ? request.condition.expected.incarnationId
            : undefined) ??
          (patch?.condition?.expected.kind === 'endpoint'
            ? patch.condition.expected.incarnationId
            : undefined)
        const next = { ...s.paneAccountRestarts }
        if (patch) {
          next[token.key] = {
            ...request,
            ...patch,
            oldIncarnationId,
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
        const notices = s.codexRestartNoticeByPtyId
        const notice = notices[request.oldPtyId]
        const retireNotice =
          (!patch || patch.condition?.expected.kind === 'empty') &&
          notice?.restartRequested &&
          (!notice.incarnationId || notice.incarnationId === oldIncarnationId)
        const nextNotices = retireNotice ? { ...notices } : notices
        if (retireNotice) {
          delete nextNotices[request.oldPtyId]
        }
        const common = {
          paneAccountRestarts: next,
          ...(nextNotices !== notices ? { codexRestartNoticeByPtyId: nextNotices } : {})
        }
        return common
      })
      if (
        !patch ||
        !['failed', 'deferred', 'unresolved'].includes(patch.phase ?? '') ||
        patch.condition?.expected.kind !== 'empty'
      ) {
        return
      }
      const state = get(),
        request = currentCodexAccountRestart(state, token)
      if (!request?.leafId) {
        return
      }
      const layout = state.terminalLayoutsByTabId[request.tabId]
      if (layout?.ptyIdsByLeafId?.[request.leafId] !== request.oldPtyId) {
        return
      }
      const bindings = { ...layout.ptyIdsByLeafId }
      delete bindings[request.leafId]
      state.setTabLayout(request.tabId, { ...layout, ptyIdsByLeafId: bindings })
      const latest = get()
      if (
        currentCodexAccountRestart(latest, token) &&
        !latest.terminalLayoutsByTabId[request.tabId]?.ptyIdsByLeafId?.[request.leafId]
      ) {
        latest.clearTabPtyId(request.tabId, request.oldPtyId)
      }
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
          const input = request.leafId
            ? request.startupInput
            : captureAgentAccountRestartResumeInput(s, 'codex', { ...pane, leafId: pane.leafId })
          const startup = structuredClone(
            buildPaneAccountRestartStartup(s, 'codex', { ...pane, leafId: pane.leafId }, input)
          )
          if (!startup) {
            return s
          }
          key = pane.key
          nextRequest = { ...request, leafId: pane.leafId, startup, startupInput: null }
        }
        const next = { ...s.paneAccountRestarts }
        delete next[token.key]
        next[key] = {
          ...nextRequest,
          phase: 'accepted',
          attemptId: nextRequest.resultPtyId ? nextRequest.attemptId : createBrowserUuid(),
          executorId: undefined
        }
        return { paneAccountRestarts: next }
      })
    }
  }
}
