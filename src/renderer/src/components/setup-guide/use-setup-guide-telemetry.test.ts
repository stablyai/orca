import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'
import {
  FEATURE_WALL_SETUP_STEP_IDS,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import { readEmittedSetupGuideStepIds } from '@/lib/feature-education-telemetry'
import {
  createSetupGuideStepCompletionTelemetryState,
  recordSetupGuideStepCompletionTelemetry
} from './use-setup-guide-telemetry'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

afterEach(() => {
  trackMock.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('setup guide step completion telemetry', () => {
  it('seeds startup-hydrated completed steps without backfilling completion events', () => {
    vi.stubGlobal('localStorage', createMemoryStorage())
    const state = createSetupGuideStepCompletionTelemetryState()

    recordSetupGuideStepCompletionTelemetry({
      state,
      progress: createProgress({}),
      setupGuideVisible: false
    })
    recordSetupGuideStepCompletionTelemetry({
      state,
      progress: createProgress({ 'split-terminal': true }),
      setupGuideVisible: false
    })

    expect(trackMock).not.toHaveBeenCalled()
    expect([...readEmittedSetupGuideStepIds()]).toEqual(['split-terminal'])

    recordSetupGuideStepCompletionTelemetry({
      state,
      progress: createProgress({ 'split-terminal': true, 'two-worktrees': true }),
      setupGuideVisible: false
    })

    expect(trackMock).not.toHaveBeenCalled()
    expect([...readEmittedSetupGuideStepIds()].sort()).toEqual(['split-terminal', 'two-worktrees'])
  })

  it('emits visible setup-guide completions during the startup baseline window', () => {
    vi.stubGlobal('localStorage', createMemoryStorage())
    const state = createSetupGuideStepCompletionTelemetryState()

    recordSetupGuideStepCompletionTelemetry({
      state,
      progress: createProgress({}),
      setupGuideVisible: true
    })
    recordSetupGuideStepCompletionTelemetry({
      state,
      progress: createProgress({ notifications: true }),
      setupGuideVisible: true
    })

    expect(trackMock).toHaveBeenCalledWith('setup_guide_step_completed', {
      step_id: 'notifications',
      section_id: 'setup',
      completed_count: 1,
      total_steps: 8,
      setup_guide_visible: true
    })
  })
})

function createProgress(
  doneOverrides: Partial<Record<FeatureWallSetupStepId, boolean>>
): FeatureWallSetupProgress {
  const stepDone = Object.fromEntries(
    FEATURE_WALL_SETUP_STEP_IDS.map((stepId) => [stepId, doneOverrides[stepId] === true])
  ) as Record<FeatureWallSetupStepId, boolean>
  return {
    ready: true,
    stepDone,
    coreDoneCount: FEATURE_WALL_SETUP_STEP_IDS.filter((stepId) => stepDone[stepId]).length,
    coreTotal: FEATURE_WALL_SETUP_STEP_IDS.length
  }
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}
