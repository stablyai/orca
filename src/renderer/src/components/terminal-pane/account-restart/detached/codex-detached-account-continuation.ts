import { readTerminalSpawnDeferral } from '../../../../../../shared/terminal/pty/admission/spawn-admission-contract'
import {
  setPaneSpawnDeferral,
  clearPaneSpawnDeferral
} from '../../session-restore/spawn-deferral/pane-spawn-deferral-registry'
import { queueDeferredRestoreRetry } from '../../session-restore/spawn-deferral/pane-spawn-deferral-drain'
import { useAppStore } from '@/store'
import {
  currentCodexAccountRestart,
  codexAccountRestartToken,
  isCodexAccountRestart,
  type CodexAccountRestartToken
} from '@/store/terminals/codex-account-restart-continuation'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-terminal-create-contract'
import type { AccountRestartCondition } from '../../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import {
  prepareCodexAccountRestart,
  failCodexAccountRestart
} from '../codex-account-restart-execution'
import { clearRetainedInlineScrollback } from '../../snapshots/terminal-scrollback-ref-hydration'
import { ptyDataHandlers } from '../../pty-transport/shutdown/pty-shutdown-data-suspension'
import { buildPaneIdentityEnv } from './detached-pane-restart-spawn-context'
import { accountRestartSlotKey, holdDetachedRestartSlot } from './detached-pane-restart-slots'
import { releaseReplacedCodexPanePty } from './detached-pane-restart-pty-release'

function claimDetachedRequest(key: string): CodexAccountRestartToken | null {
  const state = useAppStore.getState(),
    queued = state.paneAccountRestarts[key]
  if (
    !isCodexAccountRestart(queued) ||
    queued.phase !== 'accepted' ||
    hasRegisteredRuntimeTerminalTab(queued.tabId, queued.worktreeId) ||
    ptyDataHandlers.has(queued.oldPtyId)
  ) {
    return null
  }
  const claimed = state.claimCodexAccountRestart(key)
  return claimed ? codexAccountRestartToken(claimed) : null
}

function prepareDetachedRequest(
  token: CodexAccountRestartToken
): Promise<AccountRestartCondition | null> {
  const request = currentCodexAccountRestart(useAppStore.getState(), token)
  return request ? prepareCodexAccountRestart(request) : Promise.resolve(null)
}

/** Synchronous assembly lets the pending settlement retain identity, not another copy of startup. */
function dispatchDetachedRequest(
  token: CodexAccountRestartToken,
  condition: AccountRestartCondition
): Promise<string> | null {
  const state = useAppStore.getState(),
    request = currentCodexAccountRestart(state, token)
  if (!request?.startup || !request.leafId) {
    return null
  }
  if (
    hasRegisteredRuntimeTerminalTab(request.tabId, request.worktreeId) ||
    ptyDataHandlers.has(request.oldPtyId)
  ) {
    state.updateCodexAccountRestart(token, { phase: 'accepted' })
    return null
  }
  const { environmentId } = request
  if (environmentId) {
    return callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
      { kind: 'environment', environmentId },
      'terminal.create',
      {
        worktree: `id:${request.worktreeId}`,
        ...request.startup,
        tabId: condition.pane.tabId,
        leafId: condition.pane.leafId,
        accountRestart: condition,
        clientMutationId: request.attemptId,
        cwd: request.cwd,
        ...(request.shellOverride ? { shell: request.shellOverride } : {}),
        spawnIntent: 'user-resume',
        focus: false,
        presentation: 'background'
      },
      {
        timeoutMs: 15000,
        expectedEnvironmentPairingRevision: request.pairingRevision,
        expectedEnvironmentRuntimeId: request.runtimeId
      }
    ).then((result) => toRemoteRuntimePtyId(result.terminal.handle, environmentId))
  }
  return window.api.pty
    .spawn({
      cols: 80,
      rows: 24,
      cwd: request.cwd,
      ...request.startup,
      env: {
        ...request.startup.env,
        ...buildPaneIdentityEnv(state, request.worktreeId, request.tabId, request.leafId)
      },
      worktreeId: request.worktreeId,
      tabId: request.tabId,
      leafId: request.leafId,
      accountRestart: condition,
      spawnIntent: 'user-resume',
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      ...(request.shellOverride ? { shellOverride: request.shellOverride } : {}),
      ...(request.projectRuntime ? { projectRuntime: request.projectRuntime } : {}),
      initiallyHidden: true
    })
    .then((result) => result.id)
}

export async function restartDetachedAccountRequest(
  key: string,
  onSettled?: () => void
): Promise<void> {
  const token = claimDetachedRequest(key)
  if (!token) {
    return
  }
  const release = holdDetachedRestartSlot(accountRestartSlotKey(key, token), () => {
    useAppStore.getState().updateCodexAccountRestart(token, {
      phase: 'unresolved',
      error: 'terminal_account_restart_outcome_unknown'
    })
    onSettled?.()
  })
  try {
    const condition = await prepareDetachedRequest(token)
    if (!condition) {
      return
    }
    const pending = dispatchDetachedRequest(token, condition)
    if (!pending) {
      return
    }
    const id = await pending
    const state = useAppStore.getState(),
      request = currentCodexAccountRestart(state, token)
    if (!request?.leafId) {
      return
    }
    state.updateCodexAccountRestart(token, { resultPtyId: id })
    state.updateTabPtyId(request.tabId, id, request.oldPtyId)
    state.replaceTerminalLayoutPanePtyId(request.tabId, request.leafId, id)
    const layout = useAppStore.getState().terminalLayoutsByTabId[request.tabId]
    if (layout?.ptyIdsByLeafId?.[request.leafId] === id) {
      const cleared = clearRetainedInlineScrollback(layout, request.leafId)
      if (cleared !== layout) {
        state.setTabLayout(request.tabId, cleared)
      }
    }
    state.clearCodexRestartNotice(request.oldPtyId)
    state.clearCodexRestartNotice(id)
    state.updateCodexAccountRestart(token, null)
    releaseReplacedCodexPanePty(request.oldPtyId)
  } catch (error) {
    const reason = readTerminalSpawnDeferral(error)
    failCodexAccountRestart(token, error, reason ? 'deferred' : 'failed')
    const current = currentCodexAccountRestart(useAppStore.getState(), token)
    if (reason && current?.phase === 'deferred') {
      const resume = (): void => {
        const state = useAppStore.getState(),
          request = currentCodexAccountRestart(state, token)
        if (request?.phase !== 'deferred') {
          return
        }
        clearPaneSpawnDeferral(token.key)
        state.updateCodexAccountRestart(token, { phase: 'accepted' })
        onSettled?.()
      }
      setPaneSpawnDeferral(token.key, { reason, resume, accountRestart: token })
      if (reason !== 'paused') {
        queueDeferredRestoreRetry(token.key, current.environmentId, async () => {
          resume()
          return true
        })
      }
    }
  } finally {
    release()
    onSettled?.()
  }
}
