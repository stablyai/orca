import { prepareCodexAccountRestartOwner } from './codex-account-restart-owner'
export { prepareCodexAccountRestart } from './codex-account-restart-owner'
import { getTerminalNoticeLifetime } from '../provider-notices/terminal-notice-lifetime'
import { waitForPromiseWithSignal } from '../../../../../shared/concurrency/abort-signal-reason'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  ACCOUNT_RESTART_OWNER_UNVERIFIED,
  readAccountRestartReceipt,
  type AccountRestartCondition
} from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import {
  currentCodexAccountRestart,
  codexAccountRestartToken,
  type CodexAccountRestartToken
} from '@/store/terminals/codex-account-restart-continuation'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'

export function isObsoleteCodexRestartResult(
  request: CodexAccountRestart,
  result: { id: string; incarnationId?: string | null }
): boolean {
  if (
    request.resultPtyId &&
    (result.id !== request.resultPtyId ||
      (request.resultIncarnationId && result.incarnationId !== request.resultIncarnationId))
  ) {
    return true
  }
  const current = getTerminalNoticeLifetime(result.id)?.incarnationId
  return Boolean(
    current &&
    result.incarnationId &&
    current !== result.incarnationId &&
    !(result.id === request.oldPtyId && current === request.oldIncarnationId)
  )
}

/** Claim the returned endpoint before the transport admits its process lifetime. */
export function continueCodexAccountRestart(
  token: CodexAccountRestartToken,
  result?: { id: string; incarnationId?: string | null }
): boolean {
  const state = useAppStore.getState(),
    request = currentCodexAccountRestart(state, token)
  if (!request) {
    return false
  }
  const bound = request.leafId
    ? state.terminalLayoutsByTabId[request.tabId]?.ptyIdsByLeafId?.[request.leafId]
    : undefined
  if (result && bound && bound !== request.oldPtyId && bound !== result.id) {
    state.updateCodexAccountRestart(token, null)
    return false
  }
  if (result && !result.incarnationId) {
    state.updateCodexAccountRestart(token, {
      resultPtyId: result.id,
      phase: 'unresolved',
      error: ACCOUNT_RESTART_OWNER_UNVERIFIED
    })
    return false
  }
  if (result && isObsoleteCodexRestartResult(request, result)) {
    state.updateCodexAccountRestart(token, null)
    return false
  }
  if (result) {
    state.updateCodexAccountRestart(token, {
      resultPtyId: result.id,
      ...(result.incarnationId ? { resultIncarnationId: result.incarnationId } : {})
    })
  }
  return true
}

export function failCodexAccountRestart(
  token: CodexAccountRestartToken,
  error: unknown,
  settledPhase: 'failed' | 'deferred' = 'failed',
  options: { notDispatched?: true } = {}
): void {
  const state = useAppStore.getState(),
    request = currentCodexAccountRestart(state, token)
  if (!request) {
    return
  }
  const bound = request.leafId
    ? state.terminalLayoutsByTabId[request.tabId]?.ptyIdsByLeafId?.[request.leafId]
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('terminal_pane_owner_changed')) {
    state.updateCodexAccountRestart(token, null)
    return
  }
  const parsedReceipt = readAccountRestartReceipt(error)
  const receipt =
    parsedReceipt?.requestId === token.requestId && parsedReceipt.attemptId === token.attemptId
      ? parsedReceipt
      : undefined
  if (
    receipt?.outcome === 'terminal' &&
    bound &&
    bound !== request.oldPtyId &&
    bound !== request.resultPtyId
  ) {
    state.updateCodexAccountRestart(token, null)
    return
  }
  let condition = request.condition
  if (receipt && condition && receipt.current) {
    if (receipt.current.kind === 'empty' && receipt.stop === 'confirmed-retired') {
      condition = {
        ...condition,
        expected: { kind: 'empty', bindingGeneration: receipt.current.bindingGeneration }
      }
    } else if (receipt.current.kind === 'original' && condition.expected.kind === 'endpoint') {
      condition = {
        ...condition,
        expected: { ...condition.expected, bindingGeneration: receipt.current.bindingGeneration }
      }
    }
  }
  const unknown = receipt
    ? receipt.outcome !== 'terminal'
    : !(options.notDispatched && ['claimed', 'preparing'].includes(request.phase))
  state.updateCodexAccountRestart(token, {
    phase:
      unknown || (settledPhase === 'deferred' && (!receipt || receipt.stop === 'unknown'))
        ? 'unresolved'
        : settledPhase,
    condition,
    receipt,
    error: message
  })
}

export function dispatchCodexAccountRestart(
  token: CodexAccountRestartToken,
  condition: AccountRestartCondition
): boolean {
  const state = useAppStore.getState()
  const request = currentCodexAccountRestart(state, token)
  if (
    !request ||
    request.condition !== condition ||
    !['claimed', 'preparing', 'dispatched'].includes(request.phase)
  ) {
    return false
  }
  if (request.phase === 'claimed' || request.phase === 'preparing') {
    state.updateCodexAccountRestart(token, { phase: 'dispatched' })
  }
  return currentCodexAccountRestart(useAppStore.getState(), token)?.phase === 'dispatched'
}

export function restartCodexAccountSessions(
  stalePtyIds: string[],
  failures: readonly CodexAccountRestart[]
): Promise<void> {
  useAppStore.getState().queuePaneAccountRestarts(stalePtyIds, 'codex')
  return retryCodexAccountRestarts(failures)
}

export function retryCodexAccountRestarts(requests: readonly CodexAccountRestart[]): Promise<void> {
  const identities = requests.map(
    ({ startup: _startup, startupInput: _startupInput, ...identity }) => identity
  )
  return Promise.all(identities.map(retryCodexAccountRestartIdentity)).then(() => undefined)
}

async function retryCodexAccountRestartIdentity(
  request: Omit<CodexAccountRestart, 'startup' | 'startupInput'>
): Promise<void> {
  const token = codexAccountRestartToken(request),
    state = useAppStore.getState()
  const current = currentCodexAccountRestart(state, token)
  if (!current || current.phase !== request.phase) {
    return
  }
  if (request.phase === 'failed') {
    if (!request.leafId) {
      state.updateCodexAccountRestart(token, { phase: 'claimed' })
      try {
        await waitForPromiseWithSignal(
          callRuntimeRpc(
            request.environmentId
              ? { kind: 'environment', environmentId: request.environmentId }
              : { kind: 'local' },
            'session.tabs.list',
            { worktree: `id:${request.worktreeId}` },
            {
              timeoutMs: 15000,
              expectedEnvironmentPairingRevision: request.pairingRevision,
              expectedEnvironmentRuntimeId: request.runtimeId
            }
          ),
          AbortSignal.timeout(15000)
        )
      } catch (error) {
        failCodexAccountRestart(token, error)
      } finally {
        useAppStore.getState().updateCodexAccountRestart(token, { phase: 'failed' })
      }
    }
    try {
      useAppStore.getState().retryCodexAccountRestart(token)
    } catch (error) {
      failCodexAccountRestart(token, error)
    }
    return
  }
  if (request.phase !== 'unresolved') {
    return
  }
  state.updateCodexAccountRestart(token, { phase: 'reconciling' })
  try {
    const condition = await prepareCodexAccountRestartOwner(request)
    const latest = currentCodexAccountRestart(useAppStore.getState(), token)
    if (condition && request.resultPtyId && latest?.phase === 'reconciling') {
      // Requeue the verified result so a new view can attach it.
      useAppStore.getState().updateCodexAccountRestart(token, { phase: 'accepted' })
    }
  } catch (error) {
    const latest = currentCodexAccountRestart(useAppStore.getState(), token)
    if (latest && latest.phase === 'reconciling') {
      if (error instanceof Error && error.message.includes('terminal_pane_owner_changed')) {
        useAppStore.getState().updateCodexAccountRestart(token, null)
      } else {
        useAppStore.getState().updateCodexAccountRestart(token, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  } finally {
    // Reconciliation never creates a second process while the original outcome is unknown.
    const latest = currentCodexAccountRestart(useAppStore.getState(), token)
    if (latest && latest.phase === 'reconciling') {
      useAppStore.getState().updateCodexAccountRestart(token, { phase: 'unresolved' })
    }
  }
}
