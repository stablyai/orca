import { getTerminalNoticeLifetime } from '../provider-notices/terminal-notice-lifetime'
import { waitForPromiseWithSignal } from '../../../../../shared/abort-signal-reason'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toHostSessionPaneKey } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  ACCOUNT_RESTART_CAPABILITY,
  AccountRestartSnapshotSchema,
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
  const current = getTerminalNoticeLifetime(result.id)?.incarnationId
  return Boolean(
    current &&
    result.incarnationId &&
    current !== result.incarnationId &&
    !(result.id === request.oldPtyId && current === request.oldIncarnationId)
  )
}

export function prepareCodexAccountRestart(
  request: CodexAccountRestart
): Promise<AccountRestartCondition | null> {
  if (!request.startup) {
    return Promise.resolve(null)
  }
  const { startup: _startup, startupInput: _startupInput, ...identity } = request
  return prepareCodexAccountRestartOwner(identity)
}

async function prepareCodexAccountRestartOwner(
  request: Omit<CodexAccountRestart, 'startup' | 'startupInput'>
): Promise<AccountRestartCondition | null> {
  const token = codexAccountRestartToken(request)
  const state = useAppStore.getState()
  if (!request.leafId || !currentCodexAccountRestart(state, token)) {
    return null
  }
  if (getExecutionHostIdForWorktree(state, request.worktreeId) !== request.hostId) {
    state.updateCodexAccountRestart(token, null)
    return null
  }
  const environmentId = runtimeEnvironmentIdUnlessTwin(state, request.worktreeId)
  if (environmentId !== request.environmentId) {
    throw new Error('terminal_pane_owner_changed')
  }
  const call = (method: string, params?: unknown): Promise<unknown> =>
    waitForPromiseWithSignal(
      callRuntimeRpc(
        environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
        method,
        params,
        {
          timeoutMs: 15000,
          expectedEnvironmentPairingRevision: request.pairingRevision,
          expectedEnvironmentRuntimeId: request.runtimeId
        }
      ),
      AbortSignal.timeout(15000)
    )
  if (environmentId) {
    const status = await call('status.get')
    if (
      !status ||
      typeof status !== 'object' ||
      !('capabilities' in status) ||
      !Array.isArray(status.capabilities) ||
      !status.capabilities.includes(ACCOUNT_RESTART_CAPABILITY)
    ) {
      throw new Error('terminal_account_restart_unsupported')
    }
    if (!currentCodexAccountRestart(useAppStore.getState(), token)) {
      return null
    }
  }
  const hostPane = parsePaneKey(toHostSessionPaneKey(makePaneKey(request.tabId, request.leafId)))
  if (!hostPane) {
    throw new Error('terminal_pane_identity_unavailable')
  }
  const result = await call('terminal.resolvePane', {
    paneKey: makePaneKey(hostPane.tabId, hostPane.leafId),
    worktreeId: request.worktreeId,
    accountRestart: true
  })
  if (
    !result ||
    typeof result !== 'object' ||
    !('terminal' in result) ||
    !result.terminal ||
    typeof result.terminal !== 'object'
  ) {
    throw new Error('terminal_pane_owner_unverified')
  }
  const terminal = result.terminal
  const snapshot = AccountRestartSnapshotSchema.parse(
    'accountRestart' in terminal ? terminal.accountRestart : undefined
  )
  const latest = currentCodexAccountRestart(useAppStore.getState(), token)
  if (!latest || latest.phase !== 'claimed') {
    return null
  }
  if (
    getExecutionHostIdForWorktree(useAppStore.getState(), request.worktreeId) !== request.hostId ||
    runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), request.worktreeId) !== environmentId
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  if (snapshot.tabCreatedAt !== request.tabCreatedAt) {
    throw new Error('terminal_pane_owner_changed')
  }
  const previous = request.condition
  if (
    previous &&
    (snapshot.hostEpoch !== previous.hostEpoch ||
      snapshot.bindingGeneration !== previous.expected.bindingGeneration)
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  if (previous?.expected.kind === 'empty' && snapshot.owner) {
    throw new Error('terminal_pane_owner_changed')
  }
  if (snapshot.owner) {
    if (request.oldIncarnationId && request.oldIncarnationId !== snapshot.owner.incarnationId) {
      throw new Error('terminal_pane_owner_changed')
    }
    const remote = parseRemoteRuntimePtyId(request.oldPtyId)
    const same =
      previous?.expected.kind === 'endpoint'
        ? snapshot.owner.ptyId === previous.expected.ptyId &&
          snapshot.owner.incarnationId === previous.expected.incarnationId
        : remote
          ? 'handle' in terminal && terminal.handle === remote.handle
          : snapshot.owner.ptyId === request.oldPtyId
    if (!same) {
      throw new Error('terminal_pane_owner_changed')
    }
  } else if (previous?.expected.kind !== 'empty') {
    throw new Error('terminal_pane_owner_unverified')
  }
  const condition: AccountRestartCondition = {
    requestId: token.requestId,
    attemptId: token.attemptId,
    hostEpoch: snapshot.hostEpoch,
    pane: { worktreeId: request.worktreeId, ...hostPane, tabCreatedAt: snapshot.tabCreatedAt },
    expected: snapshot.owner
      ? { kind: 'endpoint', ...snapshot.owner, bindingGeneration: snapshot.bindingGeneration }
      : { kind: 'empty', bindingGeneration: snapshot.bindingGeneration }
  }
  useAppStore.getState().updateCodexAccountRestart(token, { condition, phase: 'dispatched' })
  return condition
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
  const unknown =
    (receipt && receipt.outcome !== 'terminal') ||
    (!receipt && request.phase === 'dispatched') ||
    /operation_unknown|outcome_unknown|request_timeout|rpc_timeout|timed? ?out|connection.lost/i.test(
      message
    )
  state.updateCodexAccountRestart(token, {
    phase: unknown ? 'unresolved' : settledPhase,
    condition,
    error: message
  })
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
    await prepareCodexAccountRestartOwner(request)
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
