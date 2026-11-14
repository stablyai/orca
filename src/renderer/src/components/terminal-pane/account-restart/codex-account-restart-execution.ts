import { prepareCodexAccountRestartOwner } from './codex-account-restart-owner'
export { prepareCodexAccountRestart } from './codex-account-restart-owner'
import { getTerminalNoticeLifetime } from '../provider-notices/terminal-notice-lifetime'
import { waitForPromiseWithSignal } from '../../../../../shared/abort-signal-reason'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { readAccountRestartReceipt } from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
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
  settledPhase: 'failed' | 'deferred' = 'failed'
): void {
  const state = useAppStore.getState(),
    request = currentCodexAccountRestart(state, token)
  if (!request) {
    return
  }
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
    : request.phase === 'dispatched' ||
      /operation_unknown|outcome_unknown|request_timeout|rpc_timeout|timed? ?out|connection.lost/i.test(
        message
      )
  state.updateCodexAccountRestart(token, {
    phase: unknown ? 'unresolved' : settledPhase,
    condition,
    error: message
  })
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
  state.updateCodexAccountRestart(token, { phase: 'claimed' })
  try {
    const condition = await prepareCodexAccountRestartOwner(request)
    const latest = currentCodexAccountRestart(useAppStore.getState(), token)
    if (condition && request.resultPtyId && latest?.phase === 'dispatched') {
      // Requeue the verified result so a new view can attach it.
      useAppStore.getState().updateCodexAccountRestart(token, { phase: 'accepted' })
    }
  } catch (error) {
    const latest = currentCodexAccountRestart(useAppStore.getState(), token)
    if (latest && (latest.phase === 'claimed' || latest.phase === 'dispatched')) {
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
    if (latest && (latest.phase === 'claimed' || latest.phase === 'dispatched')) {
      useAppStore.getState().updateCodexAccountRestart(token, { phase: 'unresolved' })
    }
  }
}
