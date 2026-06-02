import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSetupGuideStepSection,
  persistEmittedSetupGuideStepId,
  readEmittedSetupGuideStepIds,
  trackContextualTourOutcome,
  trackSetupGuideClosed,
  trackSetupGuideStepCompleted,
  trackTerminalPaneSplit
} from './feature-education-telemetry'

const consoleInfoMock = vi.hoisted(() => vi.fn())
const trackMock = vi.hoisted(() => vi.fn())

vi.mock('./telemetry', () => ({
  track: trackMock
}))

afterEach(() => {
  consoleInfoMock.mockClear()
  trackMock.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('feature education telemetry helpers', () => {
  beforeEachConsoleInfo()

  it('adds stable tour-depth fields to contextual tour outcomes', () => {
    trackContextualTourOutcome({
      tourId: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      outcome: 'completed',
      stepsSeen: 3,
      totalSteps: 3,
      furthestStepIndex: 5,
      definedStepCount: 5
    })

    expectLoggedFeatureEducationTelemetry('contextual_tour_outcome', {
      tour_id: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      outcome: 'completed',
      steps_seen: 3,
      total_steps: 3,
      furthest_step_index: 5,
      defined_step_count: 5
    })
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('omits stable tour-depth fields before any defined step is reached', () => {
    trackContextualTourOutcome({
      tourId: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      outcome: 'cancelled',
      stepsSeen: 0,
      totalSteps: 3
    })

    expectLoggedFeatureEducationTelemetry('contextual_tour_outcome', {
      tour_id: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      outcome: 'cancelled',
      steps_seen: 0,
      total_steps: 3
    })
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('keeps setup guide close counts schema-valid if durable progress decreases', () => {
    trackSetupGuideClosed({
      source: 'help_menu',
      outcome: 'dismissed',
      initialCompletedCount: 4,
      finalCompletedCount: 2,
      totalSteps: 8,
      activeStepId: 'notifications'
    })

    expectLoggedFeatureEducationTelemetry('setup_guide_closed', {
      source: 'help_menu',
      outcome: 'dismissed',
      initial_completed_count: 4,
      final_completed_count: 4,
      total_steps: 8,
      active_step_id: 'notifications'
    })
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('tracks setup guide step completion with bounded section and count fields', () => {
    trackSetupGuideStepCompleted({
      stepId: 'split-terminal',
      completedCount: 99,
      totalSteps: 8,
      setupGuideVisible: true
    })

    expectLoggedFeatureEducationTelemetry('setup_guide_step_completed', {
      step_id: 'split-terminal',
      section_id: 'parallel-work',
      completed_count: 8,
      total_steps: 8,
      setup_guide_visible: true
    })
    expect(trackMock).not.toHaveBeenCalled()
    expect(getSetupGuideStepSection('notifications')).toBe('setup')
  })

  it('persists emitted setup guide step ids locally without raw payload data', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)

    persistEmittedSetupGuideStepId('split-terminal')
    persistEmittedSetupGuideStepId('split-terminal')
    persistEmittedSetupGuideStepId('setup-script')

    expect([...readEmittedSetupGuideStepIds()].sort()).toEqual(['setup-script', 'split-terminal'])
  })

  it('tracks terminal pane split with explicit source and direction', () => {
    trackTerminalPaneSplit({ source: 'keyboard', direction: 'horizontal' })

    expectLoggedFeatureEducationTelemetry('terminal_pane_split', {
      source: 'keyboard',
      direction: 'horizontal'
    })
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('caps terminal pane split telemetry by source and direction for each UTC day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-02T12:00:00.000Z'))
    vi.stubGlobal('localStorage', createMemoryStorage())

    trackTerminalPaneSplit({ source: 'keyboard', direction: 'horizontal' })
    trackTerminalPaneSplit({ source: 'keyboard', direction: 'horizontal' })
    trackTerminalPaneSplit({ source: 'keyboard', direction: 'vertical' })
    trackTerminalPaneSplit({ source: 'context_menu', direction: 'horizontal' })

    expect(consoleInfoMock).toHaveBeenCalledTimes(3)
    expect(consoleInfoMock).toHaveBeenNthCalledWith(
      1,
      '[feature-education-telemetry:test-mode]',
      'terminal_pane_split',
      {
        source: 'keyboard',
        direction: 'horizontal'
      }
    )
    expect(consoleInfoMock).toHaveBeenNthCalledWith(
      2,
      '[feature-education-telemetry:test-mode]',
      'terminal_pane_split',
      {
        source: 'keyboard',
        direction: 'vertical'
      }
    )
    expect(consoleInfoMock).toHaveBeenNthCalledWith(
      3,
      '[feature-education-telemetry:test-mode]',
      'terminal_pane_split',
      {
        source: 'context_menu',
        direction: 'horizontal'
      }
    )

    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'))
    trackTerminalPaneSplit({ source: 'keyboard', direction: 'horizontal' })

    expect(consoleInfoMock).toHaveBeenCalledTimes(4)
    expect(trackMock).not.toHaveBeenCalled()
  })
})

function beforeEachConsoleInfo(): void {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(consoleInfoMock)
  })
}

function expectLoggedFeatureEducationTelemetry(name: string, props: Record<string, unknown>): void {
  expect(consoleInfoMock).toHaveBeenCalledWith(
    '[feature-education-telemetry:test-mode]',
    name,
    props
  )
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
