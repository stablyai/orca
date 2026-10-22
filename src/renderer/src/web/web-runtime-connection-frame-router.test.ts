import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { createPairedE2EEClientHandshake } from '../../../shared/paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/paired-e2ee-node-primitives'
import {
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  routeWebRuntimeConnectionFrame,
  sealWebRuntimeAuth
} from './web-runtime-connection-frame-router'

function openWebAuthForTest(
  host: nacl.BoxKeyPair,
  client: nacl.BoxKeyPair,
  frame: string
): unknown {
  const bundle = Buffer.from(frame, 'base64')
  const shared = nacl.box.before(client.publicKey, host.secretKey)
  const plaintext = nacl.box.open.after(bundle.subarray(24), bundle.subarray(0, 24), shared)
  return JSON.parse(Buffer.from(plaintext!).toString())
}

describe('web runtime connection capability advertisement', () => {
  it('advertises GitHub PR suppression and the removing marker during E2EE authentication', async () => {
    const host = nacl.box.keyPair()
    const client = nacl.box.keyPair()
    const handshake = createPairedE2EEClientHandshake({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: Buffer.from(host.publicKey).toString('base64'),
      framing: 'legacy',
      clientKeyPair: client
    })
    const sendAuth = vi.fn()

    await routeWebRuntimeConnectionFrame(JSON.stringify({ type: 'e2ee_ready' }), undefined, {
      getState: () => 'handshaking',
      getHandshake: () => handshake,
      getSocket: () => null,
      pending: new Map(),
      subscriptions: new Map(),
      sendAuth,
      setConnected: vi.fn(),
      authRejected: vi.fn()
    })

    expect(sendAuth).toHaveBeenCalledWith(handshake)
    expect(openWebAuthForTest(host, client, await sealWebRuntimeAuth(handshake, 'token'))).toEqual(
      expect.objectContaining({
        type: 'e2ee_auth',
        deviceToken: 'token',
        clientCapabilities: expect.arrayContaining([
          REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
          WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
          // The web client runs the desktop renderer, which shows Deleting from the marker.
          WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY
        ])
      })
    )
  })
})
