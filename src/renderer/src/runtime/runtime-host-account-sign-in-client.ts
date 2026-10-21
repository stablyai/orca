import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../shared/managed-account-types'
import {
  HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES,
  type HostAccountSignInProvider,
  type HostAccountSignInStatus
} from '../../../shared/host-account-sign-in-types'
import { HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY } from '../../../shared/account-runtime-capabilities'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../shared/codex-auth-errors'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { classifyTerminalProcessInspectionFailure } from '../../../shared/terminal-process-inspection'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'

type EnvironmentTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>

const CALL_TIMEOUT_MS = 20_000
// Why above the host's 20s long poll: an unchanged flow answers at its own deadline, not ours.
const WAIT_TIMEOUT_MS = 35_000
// Why: the host ends a flow nobody asked about for 90s, so retrying a lost answer longer is moot.
export const HOST_SIGN_IN_RETRY_WINDOW_MS = 80_000
const RETRY_DELAY_MS = 2_000
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'
const CANCELLED_MESSAGE: Record<HostAccountSignInProvider, string> = {
  claude: 'Claude sign-in was cancelled.',
  codex: CODEX_LOGIN_CANCELLED_MESSAGE
}

/**
 * One server's sign-in for one provider, as this client drives it:
 * `checking` (capability) -> `starting` (start sent) -> `following` (the host's flow) -> settled.
 * A Cancel only sets `cancelRequested`; the run loop delivers it as soon as the host has named its
 * flow, and again after any answer until the host has taken it. Registered before the first await,
 * so no Cancel is lost, and pinned to the pairing it started on: a re-paired id names another
 * machine, which must never get this flow's code.
 */
type Attempt = {
  owner: EnvironmentTarget
  provider: HostAccountSignInProvider
  pairingRevision: number | undefined
  stage: 'checking' | 'starting' | 'following'
  cancelRequested: boolean
  /** The host acknowledged the cancel (its flow is stopping or settled). */
  cancelDelivered: boolean
  status: HostAccountSignInStatus | null
  /** The run a second Add joins; set right after the attempt is registered. */
  done: Promise<HostAccountSignInStatus> | null
}

const attempts = new Map<string, Attempt>()
const listeners = new Set<() => void>()

const keyOf = (owner: EnvironmentTarget, provider: HostAccountSignInProvider): string =>
  `${owner.environmentId}\u0000${provider}`

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function call(
  attempt: Attempt,
  method: string,
  params: unknown,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<HostAccountSignInStatus> {
  return callRuntimeRpc<HostAccountSignInStatus>(attempt.owner, method, params, {
    timeoutMs,
    expectedEnvironmentPairingRevision: attempt.pairingRevision
  })
}

/** Records a newer status of the attempt's own flow; a slow answer never rolls it back. */
function advance(attempt: Attempt, status: HostAccountSignInStatus): void {
  const current = attempt.status
  if (current && (status.flowId !== current.flowId || status.revision <= current.revision)) {
    return
  }
  attempt.status = status
  notify()
}

/** Only a lost answer is worth asking again; a refusal or a re-paired server is final. */
export function isLostHostAnswer(error: unknown): boolean {
  const reason = classifyTerminalProcessInspectionFailure(error)
  return reason === 'timeout' || reason === 'transport_loss'
}

/** Runs `request`, asking again after lost answers until the retry window closes. */
export async function retryLostAnswers<T>(
  request: () => Promise<T>,
  windowMs = HOST_SIGN_IN_RETRY_WINDOW_MS
): Promise<T> {
  const giveUpAt = Date.now() + windowMs
  for (;;) {
    try {
      return await request()
    } catch (error) {
      if (!isLostHostAnswer(error) || Date.now() >= giveUpAt) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

async function deliverCancel(attempt: Attempt): Promise<void> {
  const flowId = attempt.status?.flowId
  if (!flowId || attempt.cancelDelivered) {
    return
  }
  advance(attempt, await call(attempt, 'accounts.hostSignInCancel', { flowId }))
  attempt.cancelDelivered = true
}

async function follow(attempt: Attempt): Promise<HostAccountSignInStatus> {
  await assertRuntimeEnvironmentCapability(
    attempt.owner.environmentId,
    HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY,
    'This server runs an older Orca that cannot add accounts from here. Update Orca on that server, or run `orca account add` in a terminal there.'
  )
  if (attempt.cancelRequested) {
    throw new Error(CANCELLED_MESSAGE[attempt.provider])
  }
  attempt.stage = 'starting'
  // Why retrying is safe: the host answers a repeated start with this owner's running flow.
  advance(
    attempt,
    await retryLostAnswers(() =>
      call(attempt, 'accounts.hostSignInStart', { provider: attempt.provider })
    )
  )
  attempt.stage = 'following'
  for (;;) {
    const status = attempt.status
    if (!status || HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(status.phase)) {
      return settle(attempt)
    }
    if (attempt.cancelRequested && !attempt.cancelDelivered) {
      // Why not fatal: an undelivered cancel is asked again after the next answer.
      await deliverCancel(attempt).catch(() => {})
      if (attempt.cancelDelivered) {
        continue
      }
    }
    advance(
      attempt,
      await retryLostAnswers(() =>
        call(
          attempt,
          'accounts.hostSignInWait',
          { flowId: status.flowId, afterRevision: status.revision },
          WAIT_TIMEOUT_MS
        )
      )
    )
  }
}

function settle(attempt: Attempt): HostAccountSignInStatus {
  const status = attempt.status
  // Why signedIn wins over a cancel: the host already saved the account, so say so.
  if (status?.phase === 'signedIn') {
    return status
  }
  if (attempt.cancelRequested || status?.phase === 'cancelled' || !status) {
    throw new Error(CANCELLED_MESSAGE[attempt.provider])
  }
  throw new Error(status.error ?? 'Sign-in failed. Try again.')
}

/** Starts a sign-in on `owner`, or joins the one this client already runs there. */
function runHostAccountSignIn(
  owner: EnvironmentTarget,
  provider: HostAccountSignInProvider
): Promise<HostAccountSignInStatus> {
  const key = keyOf(owner, provider)
  const running = attempts.get(key)
  if (running?.done) {
    return running.done
  }
  // Why one server per provider: Settings shows one Add/Cancel per provider, so Cancel always
  // has exactly one sign-in it can mean, even after Settings reopens on another server.
  if (runningHostAccountSignInOwner(provider)) {
    return Promise.reject(
      new Error(
        `A ${provider === 'claude' ? 'Claude' : 'Codex'} sign-in is still running on another server. Cancel or finish it there first.`
      )
    )
  }
  const attempt: Attempt = {
    owner,
    provider,
    pairingRevision: captureRuntimeEnvironmentRequestRevision(owner.environmentId),
    stage: 'checking',
    cancelRequested: false,
    cancelDelivered: false,
    status: null,
    done: null
  }
  attempts.set(key, attempt)
  const done = follow(attempt)
    .catch((error: unknown) => {
      // Why: after a Cancel, whatever ended the run is what the person asked for.
      if (attempt.cancelRequested && attempt.status?.phase !== 'signedIn') {
        throw new Error(CANCELLED_MESSAGE[provider])
      }
      throw error
    })
    .finally(() => {
      attempts.delete(key)
      notify()
    })
  attempt.done = done
  return done
}

/** The one server this client is signing `provider` in on, wherever Settings now points. */
export function runningHostAccountSignInOwner(
  provider: HostAccountSignInProvider
): EnvironmentTarget | null {
  for (const attempt of attempts.values()) {
    if (attempt.provider === provider) {
      return attempt.owner
    }
  }
  return null
}

/** Whether this client runs a sign-in for `provider` on `owner`, answered by the host yet or not. */
export function hasHostAccountSignIn(
  owner: RuntimeClientTarget,
  provider: HostAccountSignInProvider
): boolean {
  return owner.kind === 'environment' && attempts.has(keyOf(owner, provider))
}

export function subscribeHostAccountSignIns(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readHostAccountSignIn(
  owner: RuntimeClientTarget,
  provider: HostAccountSignInProvider
): HostAccountSignInStatus | null {
  return owner.kind === 'environment'
    ? (attempts.get(keyOf(owner, provider))?.status ?? null)
    : null
}

/** Adds a Claude account on `owner`: its login runs there, and this client relays the code. */
export async function addClaudeAccountOnHost(
  owner: EnvironmentTarget
): Promise<ClaudeRateLimitAccountsState> {
  const status = await runHostAccountSignIn(owner, 'claude')
  if (!status.claude) {
    throw new Error('Claude signed in, but the server sent no account list.')
  }
  return status.claude
}

/** Adds a Codex account on `owner` through codex's device code, opened on this device. */
export async function addCodexAccountOnHost(
  owner: EnvironmentTarget
): Promise<CodexRateLimitAccountsState> {
  const status = await runHostAccountSignIn(owner, 'codex')
  if (!status.codex) {
    throw new Error('Codex signed in, but the server sent no account list.')
  }
  return status.codex
}

export async function submitHostAccountSignInCode(
  owner: RuntimeClientTarget,
  provider: HostAccountSignInProvider,
  code: string
): Promise<void> {
  const attempt = owner.kind === 'environment' ? attempts.get(keyOf(owner, provider)) : undefined
  if (!attempt?.status || attempt.cancelRequested) {
    throw new Error(NOT_ACTIVE)
  }
  advance(
    attempt,
    await call(attempt, 'accounts.hostSignInSubmitCode', { flowId: attempt.status.flowId, code })
  )
}

/**
 * Asks to stop the sign-in. Resolves false when there is none; rejects when the host could not be
 * told yet, though the run keeps asking until it can.
 */
export async function cancelHostAccountSignIn(
  owner: RuntimeClientTarget,
  provider: HostAccountSignInProvider
): Promise<boolean> {
  const attempt = owner.kind === 'environment' ? attempts.get(keyOf(owner, provider)) : undefined
  if (!attempt) {
    return false
  }
  attempt.cancelRequested = true
  notify()
  if (attempt.stage === 'following') {
    await deliverCancel(attempt)
  }
  return true
}
