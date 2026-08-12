import { describe, expect, it } from 'vitest'
import type { TaskProvider } from '../../../../shared/types'
import {
  getAutoExpandedTaskProvider,
  getIncompleteVisibleTaskProviders,
  getStalledVisibleTaskProviders,
  getTaskProviderCompletedSteps,
  getTaskProviderSetupStatus,
  isTaskProviderReady,
  resolveStickyAutoExpandedTaskProvider,
  type TaskProviderReadiness
} from './task-source-setup-state'

const ORDER: readonly TaskProvider[] = ['github', 'gitlab', 'linear', 'jira', 'huly']

function buildReadiness(
  overrides: Partial<Record<TaskProvider, Partial<TaskProviderReadiness>>> = {}
): Record<TaskProvider, TaskProviderReadiness> {
  const base: Record<TaskProvider, TaskProviderReadiness> = {
    github: { connected: true, checking: false, visible: true },
    gitlab: { connected: true, checking: false, visible: true },
    linear: {
      connected: true,
      checking: false,
      skillInstalled: true,
      skillChecking: false,
      visible: true
    },
    jira: { connected: true, checking: false, visible: true },
    huly: { connected: false, checking: false, visible: false }
  }
  for (const provider of ORDER) {
    Object.assign(base[provider], overrides[provider])
  }
  return base
}

describe('task-source-setup-state', () => {
  it('counts Linear readiness as three steps', () => {
    expect(
      getTaskProviderCompletedSteps({
        connected: true,
        checking: false,
        skillInstalled: false,
        skillRequired: true,
        visible: true
      })
    ).toEqual({ completed: 2, total: 3 })
  })

  it('counts code-host readiness as two steps', () => {
    expect(
      getTaskProviderCompletedSteps({ connected: true, checking: false, visible: true })
    ).toEqual({ completed: 2, total: 2 })
  })

  it('marks Linear ready only when connected, skill installed, and visible', () => {
    expect(
      isTaskProviderReady({
        connected: true,
        checking: false,
        skillInstalled: true,
        skillRequired: true,
        visible: true
      })
    ).toBe(true)
    expect(
      isTaskProviderReady({
        connected: true,
        checking: false,
        skillInstalled: false,
        skillRequired: true,
        visible: true
      })
    ).toBe(false)
  })

  it('never reports ready while a check is in flight', () => {
    expect(
      isTaskProviderReady({
        connected: true,
        checking: false,
        skillInstalled: true,
        skillChecking: true,
        visible: true
      })
    ).toBe(false)
    expect(isTaskProviderReady({ connected: true, checking: true, visible: true })).toBe(false)
  })

  it('reports the first unmet step as the status', () => {
    expect(getTaskProviderSetupStatus({ connected: false, checking: true, visible: true })).toBe(
      'checking'
    )
    expect(getTaskProviderSetupStatus({ connected: false, checking: false, visible: true })).toBe(
      'connect-required'
    )
    expect(
      getTaskProviderSetupStatus({
        connected: false,
        checking: false,
        unavailable: true,
        visible: true
      })
    ).toBe('unavailable')
    expect(
      getTaskProviderSetupStatus({
        connected: true,
        checking: false,
        skillInstalled: false,
        skillRequired: true,
        visible: true
      })
    ).toBe('skill-required')
    expect(getTaskProviderSetupStatus({ connected: true, checking: false, visible: false })).toBe(
      'hidden'
    )
    expect(getTaskProviderSetupStatus({ connected: true, checking: false, visible: true })).toBe(
      'ready'
    )
  })

  it('never reports an unavailable provider as ready', () => {
    expect(
      isTaskProviderReady({
        connected: true,
        checking: false,
        unavailable: true,
        visible: true
      })
    ).toBe(false)
  })

  it('treats hidden providers as deliberately disabled regardless of connection state', () => {
    expect(getTaskProviderSetupStatus({ connected: false, checking: false, visible: false })).toBe(
      'hidden'
    )
    expect(getTaskProviderSetupStatus({ connected: false, checking: true, visible: false })).toBe(
      'hidden'
    )
  })

  it('excludes hidden and still-checking providers from the incomplete list', () => {
    const readiness = buildReadiness({
      github: { connected: false, visible: false },
      gitlab: { connected: false, checking: true },
      linear: { skillInstalled: false, skillRequired: true }
    })

    expect(getIncompleteVisibleTaskProviders(ORDER, readiness)).toEqual(['linear'])
  })

  it('auto-expands only the first incomplete visible provider', () => {
    const readiness = buildReadiness({
      gitlab: { connected: false },
      linear: { skillInstalled: false, skillRequired: true }
    })

    expect(getIncompleteVisibleTaskProviders(ORDER, readiness)).toEqual(['gitlab', 'linear'])
    expect(getAutoExpandedTaskProvider(ORDER, readiness)).toBe('gitlab')
  })

  it('auto-expands nothing once every visible provider is ready', () => {
    expect(getAutoExpandedTaskProvider(ORDER, buildReadiness())).toBeNull()
  })

  it('does not warn about providers nobody has connected yet', () => {
    // Settings ship with every provider visible, so an untouched provider is the
    // default state rather than something to flag on a fresh install.
    const untouched = buildReadiness({
      github: { connected: false },
      gitlab: { connected: false },
      linear: { connected: false, skillInstalled: false, skillRequired: true },
      jira: { connected: false }
    })

    expect(getIncompleteVisibleTaskProviders(ORDER, untouched)).toEqual([
      'github',
      'gitlab',
      'linear',
      'jira'
    ])
    expect(getStalledVisibleTaskProviders(ORDER, untouched)).toEqual([])
  })

  it('warns about setup that started and stalled partway', () => {
    const stalled = buildReadiness({
      github: { connected: false },
      linear: { skillInstalled: false, skillRequired: true }
    })

    // GitHub was never connected; Linear has a key but no skill.
    expect(getStalledVisibleTaskProviders(ORDER, stalled)).toEqual(['linear'])
  })

  it('counts an installed skill as started even without an API key', () => {
    const stalled = buildReadiness({
      linear: { connected: false, skillInstalled: true, skillRequired: true }
    })

    expect(getStalledVisibleTaskProviders(ORDER, stalled)).toEqual(['linear'])
  })

  it('keeps still-checking and hidden providers out of the warning', () => {
    const readiness = buildReadiness({
      gitlab: { connected: true, checking: true, visible: true },
      linear: { skillInstalled: false, visible: false, skillRequired: true }
    })

    expect(getStalledVisibleTaskProviders(ORDER, readiness)).toEqual([])
  })

  it('keeps the previous auto-expanded provider open while a recheck is in flight', () => {
    const whileChecking = buildReadiness({
      linear: { skillInstalled: false, skillChecking: true, skillRequired: true }
    })

    // Fresh incomplete list excludes checking providers (banner path).
    expect(getAutoExpandedTaskProvider(ORDER, whileChecking)).toBeNull()
    // Sticky path keeps Linear open so install UI is not unmounted mid-scan.
    expect(
      resolveStickyAutoExpandedTaskProvider({
        providers: ORDER,
        readinessByProvider: whileChecking,
        previousAutoExpanded: 'linear'
      })
    ).toBe('linear')
  })

  it('does not switch to a later incomplete provider during the previous provider recheck', () => {
    const whileChecking = buildReadiness({
      linear: { skillInstalled: false, skillChecking: true, skillRequired: true },
      jira: { connected: false }
    })

    expect(getAutoExpandedTaskProvider(ORDER, whileChecking)).toBe('jira')
    expect(
      resolveStickyAutoExpandedTaskProvider({
        providers: ORDER,
        readinessByProvider: whileChecking,
        previousAutoExpanded: 'linear'
      })
    ).toBe('linear')
  })

  it('does not hand the expansion to a provider whose check landed later', () => {
    // gh/glab preflight is slower than the Linear status + skill scan, so GitHub
    // only becomes eligible after Linear already auto-expanded.
    const afterPreflight = buildReadiness({
      github: { connected: false },
      gitlab: { connected: false },
      linear: { skillInstalled: false, skillRequired: true }
    })

    expect(getAutoExpandedTaskProvider(ORDER, afterPreflight)).toBe('github')
    expect(
      resolveStickyAutoExpandedTaskProvider({
        providers: ORDER,
        readinessByProvider: afterPreflight,
        previousAutoExpanded: 'linear'
      })
    ).toBe('linear')
  })

  it('keeps the auto-expand slot after the chosen provider finishes', () => {
    // Releasing it would let the next render pop a still-incomplete card open.
    const afterLinearCompletes = buildReadiness({ github: { connected: false } })

    expect(getAutoExpandedTaskProvider(ORDER, afterLinearCompletes)).toBe('github')
    expect(
      resolveStickyAutoExpandedTaskProvider({
        providers: ORDER,
        readinessByProvider: afterLinearCompletes,
        previousAutoExpanded: 'linear'
      })
    ).toBe('linear')
  })

  it('keeps the auto-expand slot when the chosen provider is hidden', () => {
    // Hiding an unfinished provider is the banner's own advice, so it must not
    // hand the expansion to another card.
    const afterHidingLinear = buildReadiness({
      github: { connected: false },
      linear: { skillInstalled: false, visible: false, skillRequired: true }
    })

    expect(
      resolveStickyAutoExpandedTaskProvider({
        providers: ORDER,
        readinessByProvider: afterHidingLinear,
        previousAutoExpanded: 'linear'
      })
    ).toBe('linear')
  })

  it('treats a Huly setup with connection but no skill as ready (skill is optional)', () => {
    const readiness = buildReadiness({
      huly: { connected: true, checking: false, visible: true, skillInstalled: false }
    })
    // Why: the Huly agent skill is optional — TaskSourceHulySetup describes it as
    // such and the readiness object mirrors that, so a connected Huly without a
    // skill still resolves as ready.
    expect(getTaskProviderSetupStatus(readiness.huly)).toBe('ready')
  })

  it('treats a Huly setup with connection + skill + visibility as ready', () => {
    const readiness = buildReadiness({
      huly: { connected: true, checking: false, visible: true, skillInstalled: true }
    })
    expect(isTaskProviderReady(readiness.huly)).toBe(true)
  })

  it('treats a hidden Huly as deliberately disabled even when connected', () => {
    const readiness = buildReadiness({
      huly: { connected: true, checking: false, visible: false, skillInstalled: true }
    })
    expect(getTaskProviderSetupStatus(readiness.huly)).toBe('hidden')
  })

  it('reports Huly as ready when connected without a skill install', () => {
    const readiness = buildReadiness({
      huly: { connected: true, checking: false, visible: true, skillInstalled: false }
    })
    expect(isTaskProviderReady(readiness.huly)).toBe(true)
  })

  it('excludes a disconnected Huly from the stalled-provider warning', () => {
    const readiness = buildReadiness({
      huly: { connected: false, checking: false, visible: true }
    })
    expect(getStalledVisibleTaskProviders(ORDER, readiness)).not.toContain('huly')
  })
})
