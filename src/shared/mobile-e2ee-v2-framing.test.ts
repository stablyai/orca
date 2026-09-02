import { describe, expect, it } from 'vitest'
import { openMobileE2EEV2Frame, sealMobileE2EEV2Frame } from './mobile-e2ee-v2-framing'

const key = new Uint8Array(32).fill(7)
const sessionId = new Uint8Array(32).fill(8)
const payload = new TextEncoder().encode('e2ee-auth')

describe('mobile E2EE v2 framing', () => {
  it('round-trips counter-zero auth with the fixed nonce layout', () => {
    const frame = sealMobileE2EEV2Frame({
      payload,
      key,
      sessionId,
      direction: 'mobile-to-desktop',
      payloadKind: 'text',
      counter: 0n
    })

    expect(Buffer.from(frame.subarray(0, 24)).toString('hex')).toBe(
      '080808080808080808080808020000000000000000000000'
    )
    expect(
      openMobileE2EEV2Frame({
        frame,
        key,
        sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'text',
        expectedCounter: 0n
      })
    ).toEqual(payload)
  })

  it('rejects replay, gap, reflection, kind confusion, and cross-session frames', () => {
    const frame = sealMobileE2EEV2Frame({
      payload,
      key,
      sessionId,
      direction: 'mobile-to-desktop',
      payloadKind: 'binary',
      counter: 4n
    })
    const attempt = (overrides: Partial<Parameters<typeof openMobileE2EEV2Frame>[0]>) =>
      openMobileE2EEV2Frame({
        frame,
        key,
        sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'binary',
        expectedCounter: 4n,
        ...overrides
      })

    expect(attempt({ expectedCounter: 3n })).toBeNull()
    expect(attempt({ expectedCounter: 5n })).toBeNull()
    expect(attempt({ direction: 'desktop-to-mobile' })).toBeNull()
    expect(attempt({ payloadKind: 'text' })).toBeNull()
    expect(attempt({ sessionId: new Uint8Array(32).fill(9) })).toBeNull()
  })

  it('uses one exact-next counter sequence across text and binary kinds', () => {
    const kinds = ['text', 'binary', 'text'] as const
    const frames = kinds.map((payloadKind, counter) =>
      sealMobileE2EEV2Frame({
        payload: new Uint8Array([counter]),
        key,
        sessionId,
        direction: 'desktop-to-mobile',
        payloadKind,
        counter: BigInt(counter)
      })
    )

    for (let counter = 0; counter < frames.length; counter++) {
      expect(
        openMobileE2EEV2Frame({
          frame: frames[counter]!,
          key,
          sessionId,
          direction: 'desktop-to-mobile',
          payloadKind: kinds[counter]!,
          expectedCounter: BigInt(counter)
        })
      ).toEqual(new Uint8Array([counter]))
    }
  })
})
