import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake
} from './mobile-e2ee-v2-contract'
import { createMobileE2EEV2Fixture, MOBILE_E2EE_V2_VECTOR } from './mobile-e2ee-v2-fixtures'

describe('mobile E2EE v2 contract', () => {
  it('validates the exact relay handshake and canonical encodings', () => {
    const { hello, ready } = createMobileE2EEV2Fixture()
    expect(validateMobileE2EEV2Handshake(hello, ready)).not.toBeNull()
  })

  it('rejects unknown fields, noncanonical base64, and an unechoed nonce', () => {
    const { hello, ready } = createMobileE2EEV2Fixture()
    expect(validateMobileE2EEV2Handshake({ ...hello, extra: true }, ready)).toBeNull()
    expect(
      validateMobileE2EEV2Handshake(
        { ...hello, clientPublicKeyB64: hello.clientPublicKeyB64.replace(/=$/, '') },
        ready
      )
    ).toBeNull()
    expect(
      validateMobileE2EEV2Handshake(hello, {
        ...ready,
        clientNonceB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
      })
    ).toBeNull()
  })

  it('rejects context and capability-selection changes', () => {
    const { hello, ready } = createMobileE2EEV2Fixture()
    expect(
      validateMobileE2EEV2Handshake(hello, {
        ...ready,
        context: { ...ready.context, relayHostId: 'ZbCdEf0123_-xyZ9' }
      })
    ).toBeNull()
    expect(
      validateMobileE2EEV2Handshake(
        { ...hello, capabilities: { framing: [2], payloadKinds: ['binary', 'text'] } },
        ready
      )
    ).toBeNull()
  })

  it('requires relayHostId only for relay context', () => {
    const { hello, ready } = createMobileE2EEV2Fixture()
    const relayWithoutId = { ...hello.context }
    delete (relayWithoutId as { relayHostId?: string }).relayHostId
    expect(validateMobileE2EEV2Handshake({ ...hello, context: relayWithoutId }, ready)).toBeNull()

    const directContext = {
      protocol: 'orca-mobile-e2ee' as const,
      initiator: 'mobile' as const,
      responder: 'desktop' as const,
      transport: 'direct' as const
    }
    expect(
      validateMobileE2EEV2Handshake(
        { ...hello, context: directContext },
        { ...ready, context: directContext }
      )
    ).not.toBeNull()
  })

  it('locks the canonical length-prefixed transcript bytes', () => {
    const { hello, ready } = createMobileE2EEV2Fixture()
    const handshake = validateMobileE2EEV2Handshake(hello, ready)
    expect(handshake).not.toBeNull()
    const transcript = encodeMobileE2EEV2Transcript(handshake!)

    expect(transcript).toHaveLength(MOBILE_E2EE_V2_VECTOR.transcriptLength)
    expect(createHash('sha256').update(transcript).digest('hex')).toBe(
      MOBILE_E2EE_V2_VECTOR.transcriptHashHex
    )
  })
})
