import { describe, expect, it } from 'vitest'
import { encrypt } from './e2ee-crypto'
import { sealMobileE2EEV2Frame } from './mobile-e2ee-v2-framing'
import {
  isRemoteRuntimeBinaryFrameWithinLimit,
  measureRemoteRuntimeSubscriptionParams,
  REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES,
  serializeRemoteRuntimePayload
} from './remote-runtime-memory-limits'

describe('remote runtime memory limits', () => {
  it('seals the largest admitted request JSON within the host inbound frame, in both framings', () => {
    const json = 'x'.repeat(REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES)
    const key = new Uint8Array(32).fill(1)
    const legacy = encrypt(json, key)
    const v2 = Buffer.from(
      sealMobileE2EEV2Frame({
        payload: new TextEncoder().encode(json),
        key,
        sessionId: new Uint8Array(32).fill(2),
        direction: 'mobile-to-desktop',
        payloadKind: 'text',
        counter: 0n
      })
    ).toString('base64')
    for (const frame of [legacy, v2]) {
      expect(frame.length).toBeLessThanOrEqual(REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES)
    }
  })

  it('accepts exact outbound JSON bytes and rejects the next byte', () => {
    expect(
      serializeRemoteRuntimePayload('x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 2))
    ).toHaveLength(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)

    expect(() =>
      serializeRemoteRuntimePayload('x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 1))
    ).toThrow(`exceeds ${REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES} bytes`)
  })

  it('accepts exact retained parameter bytes and rejects the next byte', () => {
    expect(
      measureRemoteRuntimeSubscriptionParams(
        'x'.repeat(REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES - 2)
      )
    ).toBe(REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES)

    expect(() =>
      measureRemoteRuntimeSubscriptionParams(
        'x'.repeat(REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES - 1)
      )
    ).toThrow(`exceed ${REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES} bytes`)
  })

  it('accepts an exact outbound binary frame and rejects the next byte', () => {
    expect(
      isRemoteRuntimeBinaryFrameWithinLimit(
        new Uint8Array(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES)
      )
    ).toBe(true)
    expect(
      isRemoteRuntimeBinaryFrameWithinLimit(
        new Uint8Array(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 1)
      )
    ).toBe(false)
  })
})
