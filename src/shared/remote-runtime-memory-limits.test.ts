import { describe, expect, it } from 'vitest'
import {
  isRemoteRuntimeBinaryFrameWithinLimit,
  measureRemoteRuntimeSubscriptionParams,
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES,
  serializeRemoteRuntimePayload
} from './remote-runtime-memory-limits'

describe('remote runtime memory limits', () => {
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
