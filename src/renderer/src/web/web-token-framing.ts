import {
  createPairedE2EEClientHandshake,
  type PairedE2EEClientHandshake
} from '../../../shared/remote-runtime/e2ee/paired-e2ee-client-handshake'
import type { PairedE2EEFramingPolicy } from '../../../shared/remote-runtime/e2ee/paired-e2ee-framing-policy'
import { E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/pairing/device-key-capability'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { WEB_PAIRED_E2EE_PRIMITIVES } from './web-paired-e2ee-primitives'
import {
  isWebHostLatchedToE2EEV2,
  unlatchWebHostFromE2EEV2,
  webE2EEFramingPolicy
} from './web-e2ee-v2-host-latch'
import type { WebRuntimeAuthPlan } from './web-runtime-credential-source'

/**
 * Which framing each socket's token uses. Keys and migrations are always v2. The token is v2 for
 * hosts that took it before (latched), and is tried on v2 where a refusal can be absorbed. A
 * latched host that refuses v2 is never redialed with the token over legacy: the next socket only
 * reads its status over legacy (keyed to its pinned key), and only the host's own answer that it
 * predates v2 token auth releases the latch.
 */
export class WebTokenFraming {
  private tokenOverV2 = false
  private latchedHostCheckPending = false
  private checkingLatchedHost = false
  private readonly policy: PairedE2EEFramingPolicy

  constructor(
    private readonly hostPublicKeyB64: string,
    // Only a reconnecting socket can absorb an older host refusing a v2 attempt.
    private readonly mayTryV2Token: boolean
  ) {
    this.policy = webE2EEFramingPolicy(hostPublicKeyB64)
  }

  createHandshake(plan: WebRuntimeAuthPlan): PairedE2EEClientHandshake {
    const token = plan.kind === 'legacy-token'
    this.checkingLatchedHost = token && this.latchedHostCheckPending
    this.latchedHostCheckPending = false
    this.tokenOverV2 =
      token &&
      !this.checkingLatchedHost &&
      (isWebHostLatchedToE2EEV2(this.hostPublicKeyB64) ||
        (this.mayTryV2Token && this.policy.framingForNextDial() === 'v2'))
    const handshake = createPairedE2EEClientHandshake({
      primitives: WEB_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: this.hostPublicKeyB64,
      framing: !token || this.tokenOverV2 ? 'v2' : 'legacy',
      transport: 'direct',
      ...(this.checkingLatchedHost ? {} : { legacyGate: this.policy }),
      // Why token sockets only: a migration's token auth stays the shape older key hosts accept.
      v2TokenCapabilities: this.tokenOverV2
    })
    if (!this.tokenOverV2) {
      return handshake
    }
    return {
      ...handshake,
      classifyAuthReply: (plaintext) => {
        const reply = handshake.classifyAuthReply(plaintext)
        if (reply.kind === 'authenticated') {
          this.policy.noteV2Authenticated()
        }
        return reply
      }
    }
  }

  get sentTokenOverV2(): boolean {
    return this.tokenOverV2
  }

  /** A v2 hello or v2 token auth was refused; true when reconnecting is the right response. */
  noteV2Refused(): boolean {
    if (this.policy.helloRefusalIsAuthFailure()) {
      // Why: a faked refusal must not force legacy; only the host's own status can release it.
      this.latchedHostCheckPending = this.tokenOverV2
      return this.tokenOverV2
    }
    this.tokenOverV2 = false
    this.policy.noteV2HelloRefused()
    return true
  }

  /** True when this authenticated socket only checks a latched host's status, then reconnects. */
  checkLatchedHostIfPlanned(args: {
    begin: () => void
    call: (method: string, params?: unknown) => Promise<RuntimeRpcResponse<unknown>>
    reconnect: () => void
  }): boolean {
    if (!this.checkingLatchedHost) {
      return false
    }
    this.checkingLatchedHost = false
    args.begin()
    void args
      .call('status.get')
      .then(
        (response) => {
          const capabilities = response.ok ? statusCapabilities(response.result) : null
          if (
            capabilities &&
            !capabilities.includes(E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY)
          ) {
            // The host itself says it predates v2 token auth (it was downgraded).
            unlatchWebHostFromE2EEV2(this.hostPublicKeyB64)
            this.policy.noteV2HelloRefused()
          }
        },
        () => {}
      )
      .finally(args.reconnect)
    return true
  }
}

/** The capability list of a status.get result; null when the result is not a status. */
function statusCapabilities(result: unknown): unknown[] | null {
  if (typeof result !== 'object' || result === null || !('capabilities' in result)) {
    return typeof result === 'object' && result !== null ? [] : null
  }
  return Array.isArray(result.capabilities) ? result.capabilities : null
}
