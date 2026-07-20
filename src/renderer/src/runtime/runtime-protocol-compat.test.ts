import { describe, expect, it } from 'vitest'
import {
  assertRuntimeStatusCompatible,
  getRuntimeCompatBlockDetails,
  isRuntimeCompatBlockError,
  RUNTIME_COMPAT_BLOCK_CODE
} from './runtime-protocol-compat'
import { describeRuntimeCompatBlock } from '../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'

function blockedStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'remote-runtime',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    // Old server: below the client's minimum → server-too-old block.
    runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
    hostPlatform: 'linux',
    ...overrides
  }
}

describe('assertRuntimeStatusCompatible block error threading', () => {
  it('does not throw for a compatible status', () => {
    expect(() =>
      assertRuntimeStatusCompatible(
        blockedStatus({ runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION })
      )
    ).not.toThrow()
  })

  it('throws a coded Error whose message stays the descriptive block text', () => {
    const status = blockedStatus()
    let thrown: unknown
    try {
      assertRuntimeStatusCompatible(status)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(isRuntimeCompatBlockError(thrown)).toBe(true)
    expect((thrown as { code?: string }).code).toBe(RUNTIME_COMPAT_BLOCK_CODE)
    // The runtime-environment switch flow reads only `.message`; keep it intact.
    const details = getRuntimeCompatBlockDetails(thrown)
    expect(details).not.toBeNull()
    expect((thrown as Error).message).toBe(describeRuntimeCompatBlock(details!.verdict))
  })

  it('carries the verdict and the full status on the block error', () => {
    const status = blockedStatus({ updateInfo: { installKind: 'linux-appimage' } })
    let thrown: unknown
    try {
      assertRuntimeStatusCompatible(status)
    } catch (error) {
      thrown = error
    }
    const details = getRuntimeCompatBlockDetails(thrown)
    expect(details).not.toBeNull()
    expect(details!.verdict).toMatchObject({ kind: 'blocked', reason: 'server-too-old' })
    // The exact status object is threaded so the advisor can read updateInfo/hostPlatform.
    expect(details!.status).toBe(status)
    expect(details!.status.updateInfo).toEqual({ installKind: 'linux-appimage' })
  })
})

describe('getRuntimeCompatBlockDetails', () => {
  it('returns null for non-block errors and non-errors', () => {
    expect(getRuntimeCompatBlockDetails(null)).toBeNull()
    expect(getRuntimeCompatBlockDetails(new Error('transport failed'))).toBeNull()
    expect(getRuntimeCompatBlockDetails('runtime_compat_block')).toBeNull()
  })

  it('returns null for a legacy block error lacking verdict/status', () => {
    const legacy = new Error('too old') as Error & { code?: string }
    legacy.code = RUNTIME_COMPAT_BLOCK_CODE
    expect(isRuntimeCompatBlockError(legacy)).toBe(true)
    expect(getRuntimeCompatBlockDetails(legacy)).toBeNull()
  })
})
