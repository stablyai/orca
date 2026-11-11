import {
  createPairedE2EEClientHandshake,
  type PairedE2EEClientHandshake
} from './e2ee/paired-e2ee-client-handshake'
import {
  createPairedE2EEFramingPolicy,
  type PairedE2EEFramingPolicy,
  type PairedE2EEV2LatchStore
} from './e2ee/paired-e2ee-framing-policy'
import { NODE_PAIRED_E2EE_PRIMITIVES } from './e2ee/node/paired-e2ee-node-primitives'
import { remoteRuntimeE2EEV2HostLatchStore } from './e2ee/node/remote-runtime-e2ee-v2-host-latch'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY } from './pairing/device-key-capability'
import type { RuntimeRpcResponse } from '../runtime-rpc-envelope'
import type { RuntimeStatus } from '../runtime-session-contracts'
import { serializeRemoteRuntimePayload } from './remote-runtime-memory-limits'
import { parseRemoteRuntimeJsonText } from './requests/remote-runtime-request-frames'

// Why: a host refusing v2 may be updated while this process runs; try v2 again after a while.
const V2_REFUSAL_MEMORY_MS = 30 * 60_000
const UNSUPPORTED_HELLO_CLOSE_CODE = 4001

const policies = new Map<
  string,
  { policy: PairedE2EEFramingPolicy; store: PairedE2EEV2LatchStore; createdAt: number }
>()

function framingPolicyFor(
  hostPublicKeyB64: string,
  store: PairedE2EEV2LatchStore
): PairedE2EEFramingPolicy {
  const now = Date.now()
  const existing = policies.get(hostPublicKeyB64)
  if (existing?.store === store && now - existing.createdAt < V2_REFUSAL_MEMORY_MS) {
    return existing.policy
  }
  const policy = createPairedE2EEFramingPolicy(hostPublicKeyB64, store)
  policies.set(hostPublicKeyB64, { policy, store, createdAt: now })
  return policy
}

export type RemoteRuntimeClientHandshake = PairedE2EEClientHandshake & {
  /**
   * How this dial's failure relates to v2: `older-host` (an unproven host refused v2 the way older
   * hosts do; the redial uses legacy), `latched-host` (a host that took v2 before refused it), or null.
   */
  v2Refusal: (error: unknown) => 'older-host' | 'latched-host' | null
}

type HandshakeOptions = {
  // One-shot dials may try v2 at an unproven host; long-lived sockets wait until it is latched.
  probeV2?: boolean
  // Legacy dial to a latched host that only reads its status (see latchedHostPredatesV2Token).
  latchedHostCheck?: boolean
}

/**
 * Desktop and CLI runtime clients. A host this profile has authenticated with v2 always gets v2;
 * legacy reaches it only through the status check below. Otherwise only `probeV2` dials try v2.
 * Throws on an invalid host public key.
 */
export function createRemoteRuntimeClientHandshake(
  hostPublicKeyB64: string,
  options: HandshakeOptions = {}
): RemoteRuntimeClientHandshake {
  const store = remoteRuntimeE2EEV2HostLatchStore()
  const policy = framingPolicyFor(hostPublicKeyB64, store)
  const latched = store.isLatched(hostPublicKeyB64) === true
  const framing = options.latchedHostCheck
    ? 'legacy'
    : latched
      ? 'v2'
      : options.probeV2
        ? policy.framingForNextDial()
        : 'legacy'
  const handshake = createPairedE2EEClientHandshake({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64,
    framing,
    transport: 'direct',
    ...(options.latchedHostCheck ? {} : { legacyGate: policy }),
    v2TokenCapabilities: true,
    parseJson: parseRemoteRuntimeJsonText,
    serializeJson: serializeRemoteRuntimePayload
  })
  let readyAccepted = false
  let authShapeRefused = false
  return {
    ...handshake,
    acceptReadyText: (frame) => {
      const verdict = handshake.acceptReadyText(frame)
      readyAccepted ||= verdict === 'accepted'
      return verdict
    },
    classifyAuthReply: (plaintext) => {
      const reply = handshake.classifyAuthReply(plaintext)
      if (handshake.framing === 'v2' && reply.kind === 'authenticated') {
        // Why here: only an authenticated reply proves the pinned host speaks v2.
        policy.noteV2Authenticated()
      }
      // Hosts that predate capabilities on v2 token auth answer bad_auth.
      authShapeRefused ||= reply.kind === 'rejected' && reply.errorCode === 'bad_auth'
      return reply
    },
    v2Refusal: (error) => {
      const helloRefused =
        !readyAccepted &&
        error instanceof RemoteRuntimeClientError &&
        error.closeCode === UNSUPPORTED_HELLO_CLOSE_CODE
      if (handshake.framing !== 'v2' || (!helloRefused && !authShapeRefused)) {
        return null
      }
      // Why: an on-path party can fake a refusal, so a latched host is never redialed with legacy here.
      if (policy.helloRefusalIsAuthFailure()) {
        return 'latched-host'
      }
      policy.noteV2HelloRefused()
      return policy.framingForNextDial() === 'legacy' ? 'older-host' : null
    }
  }
}

type FramingDial<TResult> = {
  attempt: (handshake: RemoteRuntimeClientHandshake) => Promise<TResult>
  readStatus: (
    handshake: RemoteRuntimeClientHandshake
  ) => Promise<RuntimeRpcResponse<RuntimeStatus>>
  signal?: AbortSignal
}

/**
 * Run a dial that sends nothing but the handshake before auth. An unproven host that refuses v2
 * gets one legacy redial. A latched host that refuses v2 is asked, over legacy framing keyed to its
 * pinned key (only the real host can answer), whether it predates v2 token auth; only that answer
 * releases the latch, so a refusal faked on the path cannot force legacy.
 */
export async function withRemoteRuntimeFramingFallback<TResult>(
  hostPublicKeyB64: string,
  dial: FramingDial<TResult>
): Promise<TResult> {
  const first = createRemoteRuntimeClientHandshake(hostPublicKeyB64, { probeV2: true })
  try {
    return await dial.attempt(first)
  } catch (error) {
    const refusal = dial.signal?.aborted ? null : first.v2Refusal(error)
    if (!refusal) {
      throw error
    }
    if (refusal === 'latched-host' && !(await latchedHostPredatesV2Token(hostPublicKeyB64, dial))) {
      throw latchedHostRefusalError(error)
    }
  }
  return await dial.attempt(createRemoteRuntimeClientHandshake(hostPublicKeyB64, { probeV2: true }))
}

async function latchedHostPredatesV2Token(
  hostPublicKeyB64: string,
  dial: FramingDial<unknown>
): Promise<boolean> {
  let status: RuntimeRpcResponse<RuntimeStatus>
  try {
    // Why status.get only: the check sends nothing worth replaying over legacy framing.
    status = await dial.readStatus(
      createRemoteRuntimeClientHandshake(hostPublicKeyB64, { latchedHostCheck: true })
    )
  } catch (error) {
    // A sealed refusal of this device's credential proves the pinned host answered: it was revoked.
    if (isCredentialRefusal(error)) {
      throw error
    }
    return false
  }
  const capabilities = status.ok ? (status.result.capabilities ?? []) : null
  if (!capabilities || capabilities.includes(E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY)) {
    return false
  }
  // The host itself says it predates v2 token auth (it was downgraded): keep it working over legacy.
  const store = remoteRuntimeE2EEV2HostLatchStore()
  store.unlatch(hostPublicKeyB64)
  framingPolicyFor(hostPublicKeyB64, store).noteV2HelloRefused()
  return true
}

function latchedHostRefusalError(error: unknown): Error {
  const message =
    'This remote Orca runtime used newer encryption (E2EE v2) before and now refuses it. ' +
    'Update Orca on that host. If it is already up to date, something between this computer ' +
    'and the host is interfering with the connection.'
  return error instanceof RemoteRuntimeClientError
    ? new RemoteRuntimeClientError(error.code, message, {
        data: error.data,
        pairingStage: error.pairingStage,
        closeCode: error.closeCode
      })
    : new Error(message)
}

function isCredentialRefusal(error: unknown): boolean {
  return (
    error instanceof RemoteRuntimeClientError &&
    error.code === 'unauthorized' &&
    error.pairingStage === 'access-grant'
  )
}
