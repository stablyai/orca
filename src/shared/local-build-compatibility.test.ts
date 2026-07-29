import { describe, expect, it } from 'vitest'
import {
  getLocalBuildCompatibilityError,
  parseLocalBuildCompatibility,
  type LocalBuildCompatibility
} from './local-build-compatibility'

function target(overrides: Partial<LocalBuildCompatibility> = {}): LocalBuildCompatibility {
  return {
    formatVersion: 1,
    appId: 'com.stablyai.orca',
    buildId: '1.2.3-abc-arm64',
    version: '1.2.3-local.1.abc',
    commit: 'abc',
    stateSchemaVersion: 1,
    readableStateSchemaVersions: [1],
    daemonProtocolVersion: 28,
    attachableDaemonProtocolVersions: [27, 28],
    platform: 'darwin',
    architecture: 'arm64',
    ...overrides
  }
}

describe('local build compatibility', () => {
  it('rejects state and live-terminal protocol incompatibilities', () => {
    expect(
      getLocalBuildCompatibilityError(target({ readableStateSchemaVersions: [2] }), 1, [])
    ).toContain('cannot read Orca workspace state schema')
    expect(getLocalBuildCompatibilityError(target(), 1, [26])).toContain(
      'cannot reconnect terminal daemon protocol 26'
    )
    expect(getLocalBuildCompatibilityError(target(), 1, [27, 28])).toBeNull()
  })

  it('parses only bounded Orca compatibility contracts', () => {
    expect(parseLocalBuildCompatibility(target())).toEqual(target())
    expect(() => parseLocalBuildCompatibility(target({ appId: 'other.app' }))).toThrow(
      'invalid compatibility metadata'
    )
    expect(() =>
      parseLocalBuildCompatibility(target({ attachableDaemonProtocolVersions: [] }))
    ).toThrow('invalid compatibility metadata')
  })
})
