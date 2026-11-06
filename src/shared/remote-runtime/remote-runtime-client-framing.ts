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
  /** True when this v2 attempt failed the way a host without v2 token auth refuses it; the redial uses legacy. */
  refusedByOlderHost: (error: unknown) => boolean
}

/**
 * Desktop and CLI runtime clients. A host this profile has authenticated with v2 always gets v2
 * (never legacy). Otherwise only `probeV2` dials try v2; the rest keep legacy framing until a probe
 * proves the host takes v2, so long-lived sockets never see an older host refuse v2.
 * Throws on an invalid host public key.
 */
export function createRemoteRuntimeClientHandshake(
  hostPublicKeyB64: string,
  options: { probeV2?: boolean } = {}
): RemoteRuntimeClientHandshake {
  const store = remoteRuntimeE2EEV2HostLatchStore()
  const policy = framingPolicyFor(hostPublicKeyB64, store)
  const latched = store.isLatched(hostPublicKeyB64) === true
  const handshake = createPairedE2EEClientHandshake({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64,
    framing: latched ? 'v2' : options.probeV2 ? policy.framingForNextDial() : 'legacy',
    transport: 'direct',
    legacyGate: policy,
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
    refusedByOlderHost: (error) => {
      if (handshake.framing !== 'v2' || policy.helloRefusalIsAuthFailure()) {
        return false
      }
      const helloRefused =
        !readyAccepted &&
        error instanceof RemoteRuntimeClientError &&
        error.closeCode === UNSUPPORTED_HELLO_CLOSE_CODE
      if (!helloRefused && !authShapeRefused) {
        return false
      }
      policy.noteV2HelloRefused()
      return policy.framingForNextDial() === 'legacy'
    }
  }
}

/** Run a dial that sends nothing but the handshake before auth; an older host gets one legacy redial. */
export async function withRemoteRuntimeFramingFallback<TResult>(
  hostPublicKeyB64: string,
  attempt: (handshake: RemoteRuntimeClientHandshake) => Promise<TResult>,
  signal?: AbortSignal
): Promise<TResult> {
  const first = createRemoteRuntimeClientHandshake(hostPublicKeyB64, { probeV2: true })
  try {
    return await attempt(first)
  } catch (error) {
    if (signal?.aborted || !first.refusedByOlderHost(error)) {
      throw error
    }
  }
  return await attempt(createRemoteRuntimeClientHandshake(hostPublicKeyB64, { probeV2: true }))
}
