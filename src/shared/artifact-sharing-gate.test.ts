import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  ARTIFACT_SHARING_DISABLED_CODE,
  ArtifactSharingDisabledError,
  assertArtifactSharingAllowed,
  isArtifactSharingEnabled
} from './artifact-sharing-gate'

describe('artifact sharing capability gate', () => {
  it('denies by default and for profiles written before the setting existed', () => {
    expect(isArtifactSharingEnabled(getDefaultSettings('/tmp'))).toBe(false)
    expect(isArtifactSharingEnabled({})).toBe(false)
    expect(isArtifactSharingEnabled(null)).toBe(false)
    expect(isArtifactSharingEnabled(undefined)).toBe(false)
  })

  it('requires an exact true, so a truthy value on disk cannot open the gate', () => {
    expect(isArtifactSharingEnabled({ artifactSharingEnabled: true })).toBe(true)
    expect(isArtifactSharingEnabled({ artifactSharingEnabled: 'yes' as never })).toBe(false)
    expect(isArtifactSharingEnabled({ artifactSharingEnabled: 1 as never })).toBe(false)
  })

  it('throws a coded, actionable error when the capability is withheld', () => {
    expect(() => assertArtifactSharingAllowed(() => false)).toThrow(ArtifactSharingDisabledError)
    try {
      assertArtifactSharingAllowed(() => false)
      expect.unreachable('gate must throw')
    } catch (error) {
      expect(error).toMatchObject({
        code: ARTIFACT_SHARING_DISABLED_CODE,
        data: { nextSteps: expect.arrayContaining([expect.stringContaining('Settings')]) }
      })
    }
    expect(() => assertArtifactSharingAllowed(() => true)).not.toThrow()
  })
})
