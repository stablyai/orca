import { describe, expect, it } from 'vitest'
import type { TaskProvider } from '../../../../shared/task-providers'
import {
  TASK_PROVIDER_SETUP_STATUS_TONE,
  getAutoExpandedTaskProvider,
  getIncompleteVisibleTaskProviders,
  getStalledVisibleTaskProviders,
  getTaskProviderCompletedSteps,
  getTaskProviderSetupStatus,
  isTaskProviderReady,
  resolveStickyAutoExpandedTaskProvider,
  type TaskProviderReadiness
} from './task-source-setup-state'

const ORDER: readonly TaskProvider[] = ['github', 'gitlab', 'linear', 'jira']

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
    jira: { connected: true, checking: false, visible: true }
  }
  for (const provider of ORDER) {
    Object.assign(base[provider], overrides[provider])
  }
  return base
}

describe('task-source-setup-state', () => {
  it('marks Linear ready only when connected, skill installed, and visible', () => {
    expect(
      isTaskProviderReady({
        connected: true,
        checking: false,
        skillInstalled: true,
        visible: true
      })
    ).toBe(true)
    expect(
      isTaskProviderReady({
        connected: true,
        checking: false,
        skillInstalled: false,
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

  it('reports an unverifiable skill scan as unknown rather than as a missing step', () => {
    const unverifiable = {
      connected: true,
      checking: false,
      skillInstalled: false,
      skillChecking: false,
      skillUnverifiable: true,
      visible: true
    }

    expect(getTaskProviderSetupStatus(unverifiable)).toBe('skill-unverified')
    expect(TASK_PROVIDER_SETUP_STATUS_TONE['skill-unverified']).toBe('attention')
    expect(isTaskProviderReady(unverifiable)).toBe(false)
    expect(getTaskProviderCompletedSteps(unverifiable)).toEqual({ completed: 2, total: 3 })
  })

  it('keeps an in-flight check and an unconnected provider ahead of an unverifiable scan', () => {
    expect(
      getTaskProviderSetupStatus({
        connected: true,
        checking: true,
        skillInstalled: false,
        skillUnverifiable: true,
        visible: true
      })
    ).toBe('checking')
    expect(
      getTaskProviderSetupStatus({
        connected: false,
        checking: false,
        skillInstalled: false,
        skillUnverifiable: true,
        visible: true
      })
    ).toBe('connect-required')
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
      linear: { skillInstalled: false }
    })

    expect(getIncompleteVisibleTaskProviders(ORDER, readiness)).toEqual(['linear'])
  })

  it('auto-expands only the first incomplete visible provider', () => {
    const readiness = buildReadiness({
      gitlab: { connected: false },
      linear: { skillInstalled: false }
    })

    expect(getIncompleteVisibleTaskProviders(ORDER, readiness)).toEqual(['gitlab', 'linear'])
    expect(getAutoExpandedTaskProvider(ORDER, readiness)).toBe('gitlab')
  })

  it('auto-expands nothing once every visible provider is ready', () => {
    expect(getAutoExpandedTaskProvider(ORDER, buildReadiness())).toBeNull()
  })

  it('does not warn about providers nobody has connected yet', () => {
    // Untouched providers are visible by default, so fresh installs need no warning.
    const untouched = buildReadiness({
      github: { connected: false },
      gitlab: { connected: false },
      linear: { connected: false, skillInstalled: false },
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
      linear: { skillInstalled: false }
    })

    expect(getStalledVisibleTaskProviders(ORDER, stalled)).toEqual(['linear'])
  })

  it('counts an installed skill as started even without an API key', () => {
    const stalled = buildReadiness({
      linear: { connected: false, skillInstalled: true }
    })

    expect(getStalledVisibleTaskProviders(ORDER, stalled)).toEqual(['linear'])
  })

  it('keeps still-checking and hidden providers out of the warning', () => {
    const readiness = buildReadiness({
      gitlab: { connected: true, checking: true, visible: true },
      linear: { skillInstalled: false, visible: false }
    })

    expect(getStalledVisibleTaskProviders(ORDER, readiness)).toEqual([])
  })

  it('keeps the previous auto-expanded provider open while a recheck is in flight', () => {
    const whileChecking = buildReadiness({
      linear: { skillInstalled: false, skillChecking: true }
    })

    expect(getAutoExpandedTaskProvider(ORDER, whileChecking)).toBeNull()
    // Keep the install terminal mounted while its skill scan runs.
    expect(
      resolveStickyAutoExpandedTaskProvider({
        providers: ORDER,
        readinessByProvider: whileChecking,
        previousAutoExpanded: 'linear'
      })
    ).toBe('linear')
  })
})
