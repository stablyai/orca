import { waitForPromiseWithSignal } from '../../../../../shared/abort-signal-reason'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'
import { getResourceExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toHostSessionPaneKey } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  toRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  ACCOUNT_RESTART_CAPABILITY,
  AccountRestartSnapshotSchema,
  type AccountRestartCondition
} from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import {
  currentCodexAccountRestart,
  codexAccountRestartToken
} from '@/store/terminals/codex-account-restart-continuation'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'

export function prepareCodexAccountRestart(
  request: CodexAccountRestart
): Promise<AccountRestartCondition | null> {
  if (!request.startup) {
    return Promise.resolve(null)
  }
  const { startup: _startup, startupInput: _startupInput, ...identity } = request
  return prepareCodexAccountRestartOwner(identity)
}

export async function prepareCodexAccountRestartOwner(
  request: Omit<CodexAccountRestart, 'startup' | 'startupInput'>
): Promise<AccountRestartCondition | null> {
  const token = codexAccountRestartToken(request)
  const state = useAppStore.getState()
  if (!request.leafId || !currentCodexAccountRestart(state, token)) {
    return null
  }
  if (getResourceExecutionHostIdForWorktree(state, request.worktreeId) !== request.hostId) {
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
    getResourceExecutionHostIdForWorktree(useAppStore.getState(), request.worktreeId) !==
      request.hostId ||
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
    snapshot.hostEpoch === previous.hostEpoch &&
    snapshot.owner &&
    'connected' in terminal &&
    terminal.connected === true &&
    'ptyId' in terminal &&
    terminal.ptyId === snapshot.owner.ptyId &&
    'launchToken' in terminal &&
    terminal.launchToken === request.attemptId &&
    'handle' in terminal &&
    typeof terminal.handle === 'string'
  ) {
    const resultPtyId = environmentId
      ? toRemoteRuntimePtyId(terminal.handle, environmentId)
      : snapshot.owner.ptyId
    const condition: AccountRestartCondition = {
      ...previous,
      expected: {
        kind: 'endpoint',
        ...snapshot.owner,
        bindingGeneration: snapshot.bindingGeneration
      }
    }
    if (!request.resultPtyId) {
      useAppStore.getState().updateCodexAccountRestart(token, {
        phase: 'accepted',
        resultPtyId,
        resultIncarnationId: snapshot.owner.incarnationId,
        condition
      })
      return null
    }
    if (
      request.resultPtyId !== resultPtyId ||
      request.resultIncarnationId !== snapshot.owner.incarnationId
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    useAppStore.getState().updateCodexAccountRestart(token, { phase: 'dispatched', condition })
    return condition
  }
  if (request.resultPtyId) {
    throw new Error('terminal_pane_owner_changed')
  }
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
