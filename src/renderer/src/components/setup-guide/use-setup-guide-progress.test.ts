import { describe, expect, it } from 'vitest'
import {
  getComputerUsePermissionSetupState,
  getCurrentSetupScriptProbeState,
  getSetupGuideProgressReady,
  getSetupScriptProbeSignature,
  markSetupScriptProbePending,
  settleSetupScriptProbe
} from './setup-guide-progress-readiness'

describe('getComputerUsePermissionSetupState', () => {
  it('does not treat a failed status read as unavailable setup completion', () => {
    expect(getComputerUsePermissionSetupState(null)).toEqual({
      ready: false,
      unavailable: false
    })
  })

  it('marks Computer Use ready only when permissions are granted and helper is available', () => {
    expect(
      getComputerUsePermissionSetupState({
        platform: 'darwin',
        helperAppPath: '/Applications/Orca Helper.app',
        helperUnavailableReason: null,
        permissions: [
          { id: 'accessibility', status: 'granted' },
          { id: 'screenshots', status: 'granted' }
        ]
      })
    ).toEqual({ ready: true, unavailable: false })
  })

  it('marks Computer Use unavailable only for explicit helper unavailability', () => {
    expect(
      getComputerUsePermissionSetupState({
        platform: 'linux',
        helperAppPath: null,
        helperUnavailableReason: 'unsupported-platform',
        permissions: []
      })
    ).toEqual({ ready: false, unavailable: true })
  })
})

describe('getSetupGuideProgressReady', () => {
  const readyInput = {
    refreshEnabled: true,
    settingsLoaded: true,
    preflightStatusChecked: true,
    linearStatusChecked: true,
    browserUseSkillDiscoveryLoading: false,
    computerUseSkillDiscoveryLoading: false,
    orchestrationSkillDiscoveryLoading: false,
    setupScriptProbeReady: true,
    computerUseSkillInstalled: false,
    computerUsePermissionStatusChecked: false
  }

  it('waits for every setup-guide skill discovery scan to settle', () => {
    expect(
      getSetupGuideProgressReady({
        ...readyInput,
        browserUseSkillDiscoveryLoading: true
      })
    ).toBe(false)
    expect(
      getSetupGuideProgressReady({
        ...readyInput,
        computerUseSkillDiscoveryLoading: true
      })
    ).toBe(false)
    expect(
      getSetupGuideProgressReady({
        ...readyInput,
        orchestrationSkillDiscoveryLoading: true
      })
    ).toBe(false)
  })

  it('treats checked but ungranted Computer Use permissions as settled readiness', () => {
    expect(
      getComputerUsePermissionSetupState({
        platform: 'darwin',
        helperAppPath: '/Applications/Orca Helper.app',
        helperUnavailableReason: null,
        permissions: [{ id: 'accessibility', status: 'not-granted' }]
      })
    ).toEqual({ ready: false, unavailable: false })
    expect(
      getSetupGuideProgressReady({
        ...readyInput,
        computerUseSkillInstalled: true,
        computerUsePermissionStatusChecked: true
      })
    ).toBe(true)
  })

  it('waits for Computer Use permission status when the skill is installed', () => {
    expect(
      getSetupGuideProgressReady({
        ...readyInput,
        computerUseSkillInstalled: true,
        computerUsePermissionStatusChecked: false
      })
    ).toBe(false)
  })

  it('waits for preflight and Linear checks', () => {
    expect(getSetupGuideProgressReady({ ...readyInput, preflightStatusChecked: false })).toBe(false)
    expect(getSetupGuideProgressReady({ ...readyInput, linearStatusChecked: false })).toBe(false)
  })
})

describe('setup script probe readiness', () => {
  it('derives the probe signature from runtime and ordered git repo inputs', () => {
    const localSignature = getSetupScriptProbeSignature({ activeRuntimeEnvironmentId: null }, [
      { id: 'repo-a', hookSettings: undefined },
      { id: 'repo-b', hookSettings: undefined }
    ])
    const remoteSignature = getSetupScriptProbeSignature(
      { activeRuntimeEnvironmentId: 'runtime-1' },
      [
        { id: 'repo-a', hookSettings: undefined },
        { id: 'repo-b', hookSettings: undefined }
      ]
    )
    const reorderedSignature = getSetupScriptProbeSignature({ activeRuntimeEnvironmentId: null }, [
      { id: 'repo-b', hookSettings: undefined },
      { id: 'repo-a', hookSettings: undefined }
    ])

    expect(localSignature).not.toBeNull()
    expect(remoteSignature).not.toBe(localSignature)
    expect(reorderedSignature).not.toBe(localSignature)
  })

  it('resets readiness on setup-script generation changes and ignores late older results', () => {
    const firstSignature = 'runtime:local|repo-a'
    const secondSignature = 'runtime:local|repo-b'
    const firstReady = settleSetupScriptProbe(
      markSetupScriptProbePending(
        { signature: null, ready: false, hasSetupScript: false },
        firstSignature
      ),
      firstSignature,
      true
    )

    expect(firstReady).toEqual({
      signature: firstSignature,
      ready: true,
      hasSetupScript: true
    })

    const secondPending = markSetupScriptProbePending(firstReady, secondSignature)
    expect(secondPending).toEqual({
      signature: secondSignature,
      ready: false,
      hasSetupScript: false
    })
    expect(getCurrentSetupScriptProbeState(firstReady, secondSignature)).toEqual(secondPending)
    expect(settleSetupScriptProbe(secondPending, firstSignature, true)).toBe(secondPending)
  })

  it('settles setup-script failures as ready with no setup script', () => {
    const signature = 'runtime:local|repo-a'
    const pending = markSetupScriptProbePending(
      { signature: null, ready: false, hasSetupScript: false },
      signature
    )

    expect(settleSetupScriptProbe(pending, signature, false)).toEqual({
      signature,
      ready: true,
      hasSetupScript: false
    })
  })

  it('allows late positive setup-script results to update after timeout settlement', () => {
    const signature = 'runtime:local|repo-a'
    const timedOut = {
      signature,
      ready: true,
      hasSetupScript: false
    }

    expect(settleSetupScriptProbe(timedOut, signature, true)).toEqual({
      signature,
      ready: true,
      hasSetupScript: true
    })
  })
})
