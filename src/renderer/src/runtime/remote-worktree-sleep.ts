import { callRuntimeRpc, RuntimeRpcCallError } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'

type RemoteTerminalListResult = {
  terminals: {
    connected: boolean
    ptyId: string | null
  }[]
  totalCount: number
  truncated: boolean
}

const LEGACY_SLEEP_VERIFY_ATTEMPTS = 8
const LEGACY_SLEEP_VERIFY_INTERVAL_MS = 250
const LEGACY_SLEEP_TIMEOUT_MS = 15_000
const LEGACY_SLEEP_RPC_TIMEOUT_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function assertVerifiedSleepResult(
  value: unknown
): asserts value is RuntimeWorktreeTerminalSleepResult & { postStopVerified: true } {
  if (
    !isRecord(value) ||
    typeof value.stopped !== 'number' ||
    !Number.isInteger(value.stopped) ||
    value.stopped < 0 ||
    !isStringArray(value.stoppedPtyIds) ||
    !isStringArray(value.livePtyIds)
  ) {
    throw new Error('terminal_worktree_sleep_invalid_response')
  }
  if (value.postStopVerified === true) {
    if (value.postStopFailure !== undefined || value.remainingLivePtyIds !== undefined) {
      throw new Error('terminal_worktree_sleep_invalid_response')
    }
    return
  }
  const failure = value.postStopFailure
  if (failure === 'terminal_worktree_sleep_still_live') {
    if (!isStringArray(value.remainingLivePtyIds)) {
      throw new Error('terminal_worktree_sleep_invalid_response')
    }
    throw Object.assign(new Error(failure), {
      remainingLivePtyIds: value.remainingLivePtyIds
    })
  }
  if (failure === 'terminal_liveness_unavailable' && value.remainingLivePtyIds === undefined) {
    throw new Error(failure)
  }
  throw new Error('terminal_worktree_sleep_unverified')
}

function hasLiveListedTerminal(value: unknown): boolean | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.terminals) ||
    !Number.isInteger(value.totalCount) ||
    (value.totalCount as number) < 0 ||
    typeof value.truncated !== 'boolean' ||
    value.truncated ||
    value.totalCount !== value.terminals.length
  ) {
    return null
  }
  for (const terminal of value.terminals as NonNullable<RemoteTerminalListResult['terminals']>) {
    if (
      !isRecord(terminal) ||
      typeof terminal.connected !== 'boolean' ||
      (typeof terminal.ptyId !== 'string' && terminal.ptyId !== null)
    ) {
      return null
    }
    // Why: old runtimes retain disconnected/null renderer placeholders; only a connected physical PTY proves liveness.
    if (terminal.connected === true && typeof terminal.ptyId === 'string' && terminal.ptyId) {
      return true
    }
  }
  return false
}

async function waitForLegacySleepConvergence(
  environmentId: string,
  worktreeSelector: string,
  deadline: number
): Promise<void> {
  let lastFailure: unknown = null
  for (let attempt = 0; attempt < LEGACY_SLEEP_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const delayMs = Math.min(LEGACY_SLEEP_VERIFY_INTERVAL_MS, deadline - Date.now())
      if (delayMs <= 0) {
        break
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs))
    }
    try {
      const listTimeoutMs = legacySleepRpcTimeout(deadline)
      const result = await callRuntimeRpc(
        { kind: 'environment', environmentId },
        'terminal.list',
        {
          worktree: worktreeSelector,
          limit: 10_000,
          requireFreshPtyLiveness: true
        },
        { timeoutMs: listTimeoutMs }
      )
      const hasLiveTerminal = hasLiveListedTerminal(result)
      if (hasLiveTerminal === false) {
        return
      }
      if (hasLiveTerminal === true) {
        // Why: a fresh legacy list can hydrate a PTY the first graph-based stop did not know about; stop again after discovery.
        await callRuntimeRpc(
          { kind: 'environment', environmentId },
          'terminal.stop',
          { worktree: worktreeSelector },
          { timeoutMs: legacySleepRpcTimeout(deadline) }
        )
        lastFailure = null
      } else {
        lastFailure = new Error('terminal_list_invalid_response')
      }
    } catch (error) {
      lastFailure = error
    }
  }
  const error = new Error('terminal_worktree_sleep_legacy_unverified')
  throw lastFailure ? Object.assign(error, { cause: lastFailure }) : error
}

function legacySleepRpcTimeout(
  deadline: number,
  maxTimeoutMs = LEGACY_SLEEP_RPC_TIMEOUT_MS
): number {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('terminal_worktree_sleep_legacy_timeout')
  }
  return Math.min(maxTimeoutMs, remainingMs)
}

export async function requestRemoteWorktreeSleep(args: {
  environmentId: string
  worktreeId: string
}): Promise<void> {
  const worktreeSelector = toRuntimeWorktreeSelector(args.worktreeId)
  try {
    const result = await callRuntimeRpc(
      { kind: 'environment', environmentId: args.environmentId },
      'terminal.sleep',
      { worktree: worktreeSelector },
      { timeoutMs: 15_000 }
    )
    assertVerifiedSleepResult(result)
    return
  } catch (error) {
    if (!(error instanceof RuntimeRpcCallError) || error.code !== 'method_not_found') {
      throw error
    }
  }

  // Why: previous runtimes lack host-authoritative discover/stop/verify; fresh polling prevents legacy stop acknowledgement from becoming a false sleeping commit.
  const legacyDeadline = Date.now() + LEGACY_SLEEP_TIMEOUT_MS
  await callRuntimeRpc(
    { kind: 'environment', environmentId: args.environmentId },
    'terminal.stop',
    { worktree: worktreeSelector },
    { timeoutMs: legacySleepRpcTimeout(legacyDeadline, LEGACY_SLEEP_TIMEOUT_MS) }
  )
  await waitForLegacySleepConvergence(args.environmentId, worktreeSelector, legacyDeadline)
}
