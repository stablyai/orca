import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../../shared/agent-accounts/managed-account-types'
import type {
  HostAccountSignInProvider,
  HostAccountSignInStatus
} from '../../../../../shared/agent-accounts/host-account-sign-in-types'
import {
  HostAccountSignInRun,
  type HostAccountSignInTransport
} from '../../../../../shared/agent-accounts/host-account-sign-in-run'
import { hostAccountSignInFailureText } from './host-account-sign-in-failure-text'
import { isLostHostAnswer } from './host-sign-in-lost-answers'
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
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'
const CANCELLED_MESSAGE: Record<HostAccountSignInProvider, string> = {
  claude: 'Claude sign-in was cancelled.',
  codex: CODEX_LOGIN_CANCELLED_MESSAGE
}

/** Per-provider host sign-in: checking → running. Register before await so Cancel persists until host names/acknowledges its flow. Pin original pairing so another machine never receives the code. */
type Attempt = {
  owner: EnvironmentTarget
  provider: HostAccountSignInProvider
  /** The saved account to re-authenticate; undefined adds a new one. */
  accountId: string | undefined
  /** Set once the capability check passes; Cancel before then ends the attempt here. */
  run: HostAccountSignInRun | null
  cancelRequested: boolean
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

function transportFor(
  owner: EnvironmentTarget,
  provider: HostAccountSignInProvider,
  pairingRevision: number | undefined,
  pinnedRuntimeId: string | undefined
): HostAccountSignInTransport {
  const call = (
    method: string,
    params: unknown,
    timeoutMs = CALL_TIMEOUT_MS,
    expectedEnvironmentRuntimeId?: string
  ): Promise<HostAccountSignInStatus> =>
    callRuntimeRpc<HostAccountSignInStatus>(owner, method, params, {
      timeoutMs,
      expectedEnvironmentPairingRevision: pairingRevision,
      expectedEnvironmentRuntimeId
    })
  return {
    // Why pinned: a replacement runtime may predate re-auth and would add a second account.
    start: (params) => call('accounts.hostSignInStart', params, CALL_TIMEOUT_MS, pinnedRuntimeId),
    wait: (params, timeoutMs) => call('accounts.hostSignInWait', params, timeoutMs),
    submitCode: (params) => call('accounts.hostSignInSubmitCode', params),
    cancel: (params) => call('accounts.hostSignInCancel', params),
    isLostAnswer: isLostHostAnswer,
    failureText: hostAccountSignInFailureText,
    cancelledText: CANCELLED_MESSAGE[provider]
  }
}

async function follow(attempt: Attempt): Promise<HostAccountSignInStatus> {
  const pairingRevision = captureRuntimeEnvironmentRequestRevision(attempt.owner.environmentId)
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
  const run = new HostAccountSignInRun(
    attempt.provider,
    attempt.accountId,
    transportFor(
      attempt.owner,
      attempt.provider,
      pairingRevision,
      attempt.accountId ? proof.runtimeId : undefined
    ),
    notify
  )
  attempt.run = run
  return run.run()
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
    run: null,
    cancelRequested: false,
    done: null
  }
  attempts.set(key, attempt)
  const done = follow(attempt)
    .catch((error: unknown) => {
      // Why: after a Cancel, whatever ended the attempt is what the person asked for.
      if (attempt.cancelRequested && attempt.run?.status?.phase !== 'signedIn') {
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
    ? (attempts.get(keyOf(owner, provider))?.run?.status ?? null)
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
  if (!attempt?.run || attempt.cancelRequested) {
    throw new Error(NOT_ACTIVE)
  }
  await attempt.run.submitCode(code)
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
  await attempt.run?.cancel()
  return true
}
