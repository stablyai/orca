// One relay link to the host of one shared agent: pairs on the host's invite, installs a resume
// credential, then resumes. Requests and streams share the link, as the phone's do. Desktop and phone
// each keep the entry and sign with the device key their own way.
import type { RpcResponse } from '../../rpc/rpc-response-shape'
import { RelayOuterError } from './relay-e2ee-link'
import type { RelayClientPlatform } from './relay-client-platform'
import { confirmRelayResume, installRelayResumeCredential } from './relay-resume-credential'
import type { RelayRpcClient } from './relay-rpc-client'
import { connectSharedHost, type SharedHostRelayCredential } from './shared-host-relay-connection'
import { mintRelayCredential } from '../relay-credential-hash'
import { MOBILE_RELAY_CLOSE_CODE } from '../mobile-relay-close-codes'

/** How this device reaches the host now. `unpaired`: no usable offer or resume credential yet. */
export type SharedHostLink = 'live' | 'connecting' | 'offline' | 'unpaired'

/** What a link reads and keeps of its device's entry for the share. */
export type SharedHostLinkEntry = {
  // The host's latest offer: its key and this device's id there, and a relay invite while unexpired.
  offer?: {
    relay: { cellUrl: string; relayHostId: string; inviteToken: string; inviteExpiresAt: number }
    hostPublicKeyB64: string
    deviceId: string
  }
  // The offer's invite the relay refused (spent or expired early): never dialed again.
  refusedInvite?: string
  // Minted and persisted before install, so a lost reply retries the same request.
  pendingResume?: { token: string; hash: string; reqId: string }
  resume?: {
    token: string
    hash: string
    version: number
    // Where the host's relay is now: it can move cells after the invite.
    relay: { cellUrl: string; relayHostId: string }
  }
}

export type SharedHostRelayLinkDeps<Entry extends SharedHostLinkEntry> = {
  platform: RelayClientPlatform
  /** What this device's client reads, declared to the host as a paired client of its kind does. */
  clientCapabilities: readonly string[]
  entry: () => Entry | undefined
  save: (entry: Entry) => void
  onLinkChanged: (link: SharedHostLink) => void
  /** Signs with the device key the host's offer names; the private key stays with the caller. */
  sign: (entry: Entry, message: Uint8Array) => Promise<Uint8Array>
  randomBytes: (length: number) => Uint8Array
  newId: () => string
}

/**
 * The relay refused the credential (an expired or spent invite, a revoked resume): drop it, so the
 * next step accepts again with the same keys rather than dialing it forever. The offer stays: its
 * host key and device id still name this device's row on the host.
 */
export function withoutRefusedCredential<Entry extends SharedHostLinkEntry>(
  entry: Entry,
  credential: SharedHostRelayCredential
): Entry {
  if (credential.kind === 'resume') {
    return { ...entry, resume: undefined }
  }
  return { ...entry, refusedInvite: credential.inviteToken }
}

type Settled = Exclude<SharedHostLink, 'connecting'>

// A host found away isn't dialed again sooner than this, however many calls ask for it.
const REDIAL_AFTER_OFFLINE_MS = 15_000

export class SharedHostRelayLink<Entry extends SharedHostLinkEntry> {
  private client: RelayRpcClient | null = null
  private connecting: Promise<Settled> | null = null
  private link: SharedHostLink = 'unpaired'
  private offlineAt = 0

  constructor(private readonly deps: SharedHostRelayLinkDeps<Entry>) {}

  current(): SharedHostLink {
    return this.link
  }

  /** Dials with `credential` unless already live or dialing; resolves once the dial settles. */
  connect(credential: SharedHostRelayCredential): Promise<Settled> {
    if (this.link === 'live') {
      return Promise.resolve('live')
    }
    if (
      !this.connecting &&
      this.link === 'offline' &&
      Date.now() - this.offlineAt < REDIAL_AFTER_OFFLINE_MS
    ) {
      return Promise.resolve('offline')
    }
    this.connecting ??= this.dial(credential).finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /** The dial in flight, or how the link stands now. */
  settled(): Promise<Settled> {
    return this.connecting ?? Promise.resolve(this.link === 'connecting' ? 'offline' : this.link)
  }

  request(method: string, params: unknown): Promise<RpcResponse> {
    return this.client
      ? this.client.sendRequest(method, params)
      : Promise.reject(new Error('shared host not connected'))
  }

  subscribe(method: string, params: unknown, listener: (result: unknown) => void): () => void {
    if (!this.client) {
      listener({ type: 'error', message: 'shared host not connected' })
      return () => {}
    }
    return this.client.subscribe(method, params, listener)
  }

  close(): void {
    const { client } = this
    this.client = null
    client?.close()
    this.setLink('unpaired')
  }

  private setLink(link: SharedHostLink): void {
    if (link === 'offline') {
      this.offlineAt = Date.now()
    }
    if (link !== this.link) {
      this.link = link
      this.deps.onLinkChanged(link)
    }
  }

  private dial(credential: SharedHostRelayCredential): Promise<Settled> {
    const entry = this.deps.entry()
    const offer = entry?.offer
    if (!entry || !offer) {
      return Promise.resolve('unpaired')
    }
    this.setLink('connecting')
    return new Promise<Settled>((resolve) => {
      const client = connectSharedHost(
        {
          platform: this.deps.platform,
          connection: {
            kind: 'shared-host',
            relay: entry.resume?.relay ?? offer.relay,
            hostPublicKeyB64: offer.hostPublicKeyB64,
            deviceId: offer.deviceId,
            relayCredential: credential
          },
          sign: (message) => this.deps.sign(entry, message),
          clientCapabilities: this.deps.clientCapabilities
        },
        {
          onAuthenticated: () => {
            void this.afterAuthenticated(client, credential).then(
              () => {
                // Closed while the resume credential settled: this link is no longer the live one.
                if (this.client !== client) {
                  resolve('unpaired')
                  return
                }
                this.setLink('live')
                resolve('live')
              },
              (error: unknown) => {
                console.warn('[shared-agents] could not keep a resume credential', error)
                client.close()
              }
            )
          },
          onClosed: (error, intentional) => {
            if (this.client !== client) {
              resolve('unpaired')
              return
            }
            this.client = null
            const settled = intentional ? 'offline' : this.afterClosed(credential, error)
            this.setLink(settled)
            resolve(settled)
          }
        }
      )
      this.client = client
    })
  }

  /** Invite: install a resume credential for later dials. Resume: renew it with the host. */
  private async afterAuthenticated(
    client: RelayRpcClient,
    credential: SharedHostRelayCredential
  ): Promise<void> {
    const entry = this.deps.entry()
    if (!entry) {
      return
    }
    if (credential.kind === 'resume') {
      if (entry.resume) {
        await confirmRelayResume(
          client,
          `confirm-${this.deps.newId()}`,
          entry.resume.relay.relayHostId
        )
      }
      return
    }
    const pending = entry.pendingResume ?? {
      ...mintRelayCredential(this.deps.randomBytes),
      reqId: `share-${this.deps.newId()}`
    }
    this.deps.save({ ...entry, pendingResume: pending })
    const { installed, relay } = await installRelayResumeCredential(client, pending)
    this.deps.save({
      ...(this.deps.entry() ?? entry),
      pendingResume: undefined,
      resume: {
        token: pending.token,
        hash: pending.hash,
        version: installed.currentVersion,
        relay: { cellUrl: relay.cellUrl, relayHostId: relay.relayHostId }
      }
    })
  }

  /** The host is away (offline), or refused this credential (unpaired until it answers an accept). */
  private afterClosed(credential: SharedHostRelayCredential, error: Error): Settled {
    if (
      error instanceof RelayOuterError &&
      error.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL
    ) {
      const entry = this.deps.entry()
      if (entry) {
        this.deps.save(withoutRefusedCredential(entry, credential))
      }
      return 'unpaired'
    }
    return 'offline'
  }
}
