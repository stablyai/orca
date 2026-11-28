import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../../shared/agent-accounts/managed-account-types'
import {
  HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES,
  type HostAccountSignInProvider,
  type HostAccountSignInStatus
} from '../../../../../shared/agent-accounts/host-account-sign-in-types'
import { hostAccountSignInFailureText, noPromptOutcome } from './host-account-sign-in-failure-text'
import { isLostHostAnswer, retryLostAnswers } from './host-sign-in-lost-answers'
import {
  HOST_ACCOUNT_REAUTH_RUNTIME_CAPABILITY,
  HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY
} from '../../../../../shared/remote-runtime/protocol/account-runtime-capabilities'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../../../shared/agent-accounts/codex/codex-auth-errors'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { runtimeEnvironmentCapabilityProof } from '../../rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { captureRuntimeEnvironmentRequestRevision } from '../../rpc/environment-revisions/runtime-environment-revision'

type EnvironmentTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>

const CALL_TIMEOUT_MS = 20_000
// Why above the host's 20s long poll: an unchanged flow answers at its own deadline, not ours.
const WAIT_TIMEOUT_MS = 35_000
// Why above the host's own 60s: a current host names its failure first; this ends hosts that predate it.
const PROMPT_DEADLINE_MS = 90_000
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'
const CANCELLED_MESSAGE: Record<HostAccountSignInProvider, string> = {
  claude: 'Claude sign-in was cancelled.',
  codex: CODEX_LOGIN_CANCELLED_MESSAGE
}

/** Per-provider host sign-in: checking → starting → following → settled. Register before await so Cancel persists until host names/acknowledges its flow, retrying after answers. Pin original pairing so another machine never receives the code. */
type Attempt = {
  owner: EnvironmentTarget
  provider: HostAccountSignInProvider
  /** The saved account to re-authenticate; undefined adds a new one. */
  accountId: string | undefined
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
  timeoutMs = CALL_TIMEOUT_MS,
  expectedEnvironmentRuntimeId?: string
): Promise<HostAccountSignInStatus> {
  return callRuntimeRpc<HostAccountSignInStatus>(attempt.owner, method, params, {
    timeoutMs,
    expectedEnvironmentPairingRevision: attempt.pairingRevision,
    expectedEnvironmentRuntimeId
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

async function deliverCancel(attempt: Attempt): Promise<void> {
  const flowId = attempt.status?.flowId
  if (!flowId || attempt.cancelDelivered) {
    return
  }
  advance(attempt, await call(attempt, 'accounts.hostSignInCancel', { flowId }))
  attempt.cancelDelivered = true
}

async function follow(attempt: Attempt): Promise<HostAccountSignInStatus> {
  const proof = await runtimeEnvironmentCapabilityProof(
    attempt.owner.environmentId,
    attempt.accountId
      ? HOST_ACCOUNT_REAUTH_RUNTIME_CAPABILITY
      : HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY
  )
  if (!proof.supported) {
    throw new Error(
      attempt.accountId
        ? 'This server runs an older Orca that cannot re-authenticate accounts from here. Update Orca on that server, or remove the account and add it again.'
        : 'This server runs an older Orca that cannot add accounts from here. Update Orca on that server, or run `orca account add` in a terminal there.'
    )
  }
  if (attempt.cancelRequested) {
    throw new Error(CANCELLED_MESSAGE[attempt.provider])
  }
  attempt.stage = 'starting'
  // Why retrying is safe: the host answers a repeated start with this owner's running flow.
  advance(
    attempt,
    await retryLostAnswers(() =>
      call(
        attempt,
        'accounts.hostSignInStart',
        {
          provider: attempt.provider,
          ...(attempt.accountId ? { accountId: attempt.accountId } : {})
        },
        CALL_TIMEOUT_MS,
        // Why pinned: a replacement runtime may predate re-auth and would add a second account.
        attempt.accountId ? proof.runtimeId : undefined
      )
    )
  )
  attempt.stage = 'following'
  const promptDeadline = Date.now() + PROMPT_DEADLINE_MS
  for (;;) {
    const status = attempt.status
    if (!status || HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(status.phase)) {
      return settle(attempt)
    }
    if (status.phase === 'starting' && !attempt.cancelRequested && Date.now() >= promptDeadline) {
      await deliverCancel(attempt).catch(() => {})
      return noPromptOutcome(attempt.status, status)
    }
    if (attempt.cancelRequested && !attempt.cancelDelivered) {
      // Why not fatal: an undelivered cancel is asked again after the next answer.
      await deliverCancel(attempt).catch(() => {})
      if (attempt.cancelDelivered) {
        continue
      }
    }
    // A link wait never outlives the deadline: each try gets only the time left, and once it passes a lost
    // answer ends here as no link. A cancelled attempt waits normally for the host to settle it.
    const bounded = status.phase === 'starting' && !attempt.cancelRequested
    const untilDeadline = bounded ? Math.max(0, promptDeadline - Date.now()) : undefined
    const wait = () =>
      call(
        attempt,
        'accounts.hostSignInWait',
        { flowId: status.flowId, afterRevision: status.revision },
        bounded
          ? Math.max(1, Math.min(WAIT_TIMEOUT_MS, promptDeadline - Date.now()))
          : WAIT_TIMEOUT_MS
      )
    advance(
      attempt,
      await retryLostAnswers(wait, untilDeadline).catch((error: unknown) => {
        if (untilDeadline === undefined || !isLostHostAnswer(error)) {
          throw error
        }
        return status
      })
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
  throw new Error(hostAccountSignInFailureText(status))
}

/** Starts a sign-in on `owner`, or joins the same one this client already runs there. */
function runHostAccountSignIn(
  owner: EnvironmentTarget,
  provider: HostAccountSignInProvider,
  accountId: string | undefined
): Promise<HostAccountSignInStatus> {
  const key = keyOf(owner, provider)
  const running = attempts.get(key)
  if (running && running.accountId !== accountId) {
    return Promise.reject(
      new Error('Another sign-in is already running on this server. Finish or cancel it first.')
    )
  }
  if (running?.done) {
    return running.done
  }
  // One Add/Cancel per provider requires exactly one active server flow, even after Settings switches servers.
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
    accountId,
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

/** Adds a Claude account on `owner`, or re-authenticates `accountId`: its login runs there, and this client relays the code. */
export async function signInClaudeAccountOnHost(
  owner: EnvironmentTarget,
  accountId?: string
): Promise<ClaudeRateLimitAccountsState> {
  const status = await runHostAccountSignIn(owner, 'claude', accountId)
  if (!status.claude) {
    throw new Error('Claude signed in, but the server sent no account list.')
  }
  return status.claude
}

/** Adds a Codex account on `owner`, or re-authenticates `accountId`, through codex's device code opened on this device. */
export async function signInCodexAccountOnHost(
  owner: EnvironmentTarget,
  accountId?: string
): Promise<CodexRateLimitAccountsState> {
  const status = await runHostAccountSignIn(owner, 'codex', accountId)
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
