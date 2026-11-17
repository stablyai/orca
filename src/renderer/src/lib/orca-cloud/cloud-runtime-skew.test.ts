import { describe, expect, it } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/remote-runtime/protocol/protocol-version'
import { evaluateCloudRuntimeSkew } from './cloud-runtime-skew'

// Desktop speaks protocol 5 and still accepts sandboxes down to 3.
const desktop = { protocolVersion: 5, minCompatibleServerProtocolVersion: 3 }
const COMMIT = 'c'.repeat(40)

describe('evaluateCloudRuntimeSkew', () => {
  it('tolerates any sandbox inside the range, older or newer', () => {
    for (const sandbox of [3, 4, 5, 6, 9]) {
      expect(
        evaluateCloudRuntimeSkew(
          { runtimeProtocolVersion: sandbox, minCompatibleRuntimeClientVersion: 3 },
          desktop
        )
      ).toEqual({ kind: 'compatible' })
    }
  })

  it('reports an older sandbox below the desktop minimum, with its build', () => {
    expect(
      evaluateCloudRuntimeSkew(
        {
          runtimeProtocolVersion: 2,
          minCompatibleRuntimeClientVersion: 1,
          appVersion: '1.4.0',
          buildCommit: COMMIT
        },
        desktop
      )
    ).toEqual({
      kind: 'sandbox-older',
      desktopProtocolVersion: 5,
      sandboxProtocolVersion: 2,
      sandboxAppVersion: '1.4.0',
      sandboxBuildCommit: COMMIT
    })
  })

  it('reports an older desktop when the sandbox requires a newer client', () => {
    expect(
      evaluateCloudRuntimeSkew(
        { runtimeProtocolVersion: 8, minCompatibleRuntimeClientVersion: 6 },
        desktop
      )
    ).toMatchObject({ kind: 'desktop-older', sandboxProtocolVersion: 8, sandboxBuildCommit: null })
  })

  it('a desktop that is too old wins over a sandbox that is too old', () => {
    expect(
      evaluateCloudRuntimeSkew(
        { runtimeProtocolVersion: 2, minCompatibleRuntimeClientVersion: 6 },
        desktop
      ).kind
    ).toBe('desktop-older')
  })

  it('reads the legacy mobile aliases, and treats a missing protocol as an old sandbox', () => {
    expect(
      evaluateCloudRuntimeSkew({ protocolVersion: 4, minCompatibleMobileVersion: 2 }, desktop)
    ).toEqual({ kind: 'compatible' })
    expect(evaluateCloudRuntimeSkew({}, desktop).kind).toBe('sandbox-older')
  })

  it('uses this build’s protocol constants by default', () => {
    expect(
      evaluateCloudRuntimeSkew({
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
      })
    ).toEqual({ kind: 'compatible' })
  })
})
