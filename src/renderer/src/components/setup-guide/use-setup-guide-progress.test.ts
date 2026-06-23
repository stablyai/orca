import { describe, expect, it } from 'vitest'
import {
  FEATURE_WALL_SETUP_STEPS,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'
import {
  getSetupGuideBrowserMilestoneAwareProgress,
  shouldMarkBrowserMilestoneLegacyComplete
} from './setup-guide-browser-milestone-progress'
import {
  getComputerUsePermissionSetupState,
  getCurrentSetupScriptProbeState,
  getSetupGuideProgressReady,
  getSetupScriptProbeSignature,
  markSetupScriptProbePending,
  settleSetupScriptProbe
} from './setup-guide-progress-readiness'

function makePreBrowserDoneStepState(): Partial<Record<FeatureWallSetupStepId, boolean>> {
  return Object.fromEntries(
    FEATURE_WALL_SETUP_STEPS.map((step) => [step.id, step.id !== 'browser'])
  ) as Partial<Record<FeatureWallSetupStepId, boolean>>
}

function makeProgress(overrides: Partial<FeatureWallSetupProgress> = {}): FeatureWallSetupProgress {
  return {
    ready: true,
    stepDone: {
      'default-agent': false,
      'add-two-repos': false,
      notifications: false,
      'split-terminal': false,
      'two-worktrees': false,
      browser: false,
      'task-sources': false,
      'agent-capabilities': false,
      'setup-script': false
    },
    coreDoneCount: 0,
    coreTotal: FEATURE_WALL_SETUP_STEPS.length,
    ...overrides
  }
}

describe('browser milestone legacy setup guide progress', () => {
  it('marks old profiles as legacy-complete when pre-browser steps were already done', () => {
    expect(
      shouldMarkBrowserMilestoneLegacyComplete({
        stepDone: makePreBrowserDoneStepState(),
        setupGuideSidebarDismissed: false
      })
    ).toBe(true)
  })

  it('marks old profiles as legacy-complete when the sidebar checklist was dismissed', () => {
    expect(
      shouldMarkBrowserMilestoneLegacyComplete({
        stepDone: {},
        setupGuideSidebarDismissed: true
      })
    ).toBe(true)
  })

  it('does not mark old active incomplete profiles as legacy-complete', () => {
    expect(
      shouldMarkBrowserMilestoneLegacyComplete({
        stepDone: {
          'split-terminal': true
        },
        setupGuideSidebarDismissed: false
      })
    ).toBe(false)
  })

  it('keeps legacy-complete setup guide progress complete across all surfaces', () => {
    const progress = getSetupGuideBrowserMilestoneAwareProgress(
      makeProgress({
        stepDone: makePreBrowserDoneStepState() as Record<FeatureWallSetupStepId, boolean>,
        coreDoneCount: FEATURE_WALL_SETUP_STEPS.length - 1
      }),
      true
    )

    expect(progress.coreDoneCount).toBe(FEATURE_WALL_SETUP_STEPS.length)
    expect(progress.stepDone.browser).toBe(true)
    expect(Object.values(progress.stepDone).every(Boolean)).toBe(true)
  })

  it('leaves fresh setup guide progress unchanged when browser is incomplete', () => {
    const original = makeProgress({
      stepDone: makePreBrowserDoneStepState() as Record<FeatureWallSetupStepId, boolean>,
      coreDoneCount: FEATURE_WALL_SETUP_STEPS.length - 1
    })

    expect(getSetupGuideBrowserMilestoneAwareProgress(original, false)).toBe(original)
  })
})

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
    jiraStatusChecked: true,
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

  it('waits for preflight, Linear, and Jira checks', () => {
    expect(getSetupGuideProgressReady({ ...readyInput, preflightStatusChecked: false })).toBe(false)
    expect(getSetupGuideProgressReady({ ...readyInput, linearStatusChecked: false })).toBe(false)
    expect(getSetupGuideProgressReady({ ...readyInput, jiraStatusChecked: false })).toBe(false)
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
