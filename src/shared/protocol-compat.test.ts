import { describe, expect, it } from 'vitest'
import {
  describeRuntimeCompatBlock,
  evaluateCompat,
  evaluateRuntimeCompat
} from './protocol-compat'
import {
  DESKTOP_PROTOCOL_VERSION,
  MIN_COMPATIBLE_MOBILE_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from './protocol-version'

const MOBILE_V = 1

describe('evaluateCompat', () => {
  it('returns ok when both desktop fields are undefined and constants are wide-open', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: undefined,
      desktopMinCompatibleMobileVersion: undefined
    })
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('returns ok when desktop reports version equal to mobile', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: MOBILE_V,
      desktopMinCompatibleMobileVersion: 0
    })
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('returns ok when desktop reports a newer version (additive changes assumed safe)', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: MOBILE_V + 5,
      desktopMinCompatibleMobileVersion: 0
    })
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('blocks with mobile-too-old when desktop requires a newer mobile', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: 5,
      desktopMinCompatibleMobileVersion: MOBILE_V + 1
    })
    expect(verdict).toEqual({
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion: 5,
      requiredMobileVersion: MOBILE_V + 1
    })
  })

  it('coerces undefined desktopVersion to 0 in the verdict payload', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: undefined,
      desktopMinCompatibleMobileVersion: MOBILE_V + 1
    })
    expect(verdict).toMatchObject({
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion: 0
    })
  })

  it('blocks with desktop-too-old when desktop reports below the local minimum', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 5,
      desktopProtocolVersion: 3,
      desktopMinCompatibleMobileVersion: 0
    })
    expect(verdict).toEqual({
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion: 3,
      requiredDesktopVersion: 5
    })
  })

  it('mobile-too-old wins precedence when both constraints would fire', () => {
    // Why: documents the intended kill-switch precedence — desktop's
    // refusal of a too-old mobile takes priority over mobile's local
    // refusal of a too-old desktop.
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 99,
      desktopProtocolVersion: -1,
      desktopMinCompatibleMobileVersion: MOBILE_V + 1
    })
    expect(verdict.kind).toBe('blocked')
    expect((verdict as { reason: string }).reason).toBe('mobile-too-old')
  })

  it('with minCompatibleDesktopVersion = 0 every reported desktop passes', () => {
    for (const v of [0, 1, 2, 99]) {
      expect(
        evaluateCompat({
          mobileProtocolVersion: MOBILE_V,
          minCompatibleDesktopVersion: 0,
          desktopProtocolVersion: v,
          desktopMinCompatibleMobileVersion: 0
        })
      ).toEqual({ kind: 'ok' })
    }
  })

  it('hard-blocks protocol-1 mobile for the binary terminal stream cutover', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: 1,
      minCompatibleDesktopVersion: DESKTOP_PROTOCOL_VERSION,
      desktopProtocolVersion: DESKTOP_PROTOCOL_VERSION,
      desktopMinCompatibleMobileVersion: MIN_COMPATIBLE_MOBILE_VERSION
    })

    expect(verdict).toEqual({
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion: DESKTOP_PROTOCOL_VERSION,
      requiredMobileVersion: MIN_COMPATIBLE_MOBILE_VERSION
    })
  })
})

describe('evaluateRuntimeCompat', () => {
  it('keeps the current client and current server self-compatible', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      serverMinCompatibleClientProtocolVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    })

    expect(verdict).toMatchObject({ kind: 'ok' })
  })

  it('allows client and server app versions to skew when protocol ranges overlap', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: RUNTIME_PROTOCOL_VERSION + 3,
      serverMinCompatibleClientProtocolVersion: RUNTIME_PROTOCOL_VERSION - 1
    })

    expect(verdict).toMatchObject({ kind: 'ok' })
  })

  it('blocks when the server requires a newer client protocol', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1,
      serverMinCompatibleClientProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1
    })

    expect(verdict).toMatchObject({
      kind: 'blocked',
      reason: 'client-too-old',
      requiredClientProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1
    })
    expect(describeRuntimeCompatBlock(verdict)).toContain('client is too old')
  })

  it('blocks when the server protocol is below the client minimum', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      serverProtocolVersion: RUNTIME_PROTOCOL_VERSION - 1,
      serverMinCompatibleClientProtocolVersion: 0
    })

    expect(verdict).toMatchObject({
      kind: 'blocked',
      reason: 'server-too-old',
      requiredServerProtocolVersion: RUNTIME_PROTOCOL_VERSION
    })
    expect(describeRuntimeCompatBlock(verdict)).toContain('server is too old')
  })

  it('treats missing server fields as protocol 0', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: 1,
      serverProtocolVersion: undefined,
      serverMinCompatibleClientProtocolVersion: undefined
    })

    expect(verdict).toMatchObject({
      kind: 'blocked',
      reason: 'server-too-old',
      serverProtocolVersion: 0
    })
  })
})
