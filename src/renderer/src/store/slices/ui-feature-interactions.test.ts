import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

const mocks = vi.hoisted(() => ({
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

vi.mock('sonner', () => ({
  toast: {
    message: mocks.toastMessage,
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  mocks.sendNotesToActiveAgentSession.mockReset()
  mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
  mocks.track.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

describe('createUISlice feature interactions', () => {
  it('normalizes persisted feature interaction records during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        featureInteractions: {
          tasks: { firstInteractedAt: 100 },
          automations: { firstInteractedAt: 150, interactionCount: 4 },
          browser: { firstInteractedAt: Number.NaN },
          unknown: { firstInteractedAt: 200 }
        } as unknown as FeatureInteractionState
      })
    )

    expect(store.getState().featureInteractions).toEqual({
      tasks: { firstInteractedAt: 100, interactionCount: 1 },
      automations: { firstInteractedAt: 150, interactionCount: 4 }
    })
  })

  it('records feature interaction counts and persists each interaction', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()
      store.getState().hydratePersistedUI(makePersistedUI())
      setMock.mockClear()

      store.getState().recordFeatureInteraction('tasks')
      store.getState().recordFeatureInteraction('tasks')

      const expected: FeatureInteractionState = {
        tasks: { firstInteractedAt: now, interactionCount: 2 }
      }
      expect(store.getState().featureInteractions).toEqual(expected)
      expect(setMock).toHaveBeenCalledTimes(2)
      expect(setMock).toHaveBeenCalledWith({ featureInteractions: expected })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the main-owned feature interaction increment API when available', async () => {
    const recordFeatureInteractionMock = vi.fn(() =>
      Promise.resolve(
        makePersistedUI({
          featureInteractions: {
            tasks: { firstInteractedAt: 100, interactionCount: 3 }
          },
          contextualToursSeenIds: ['browser']
        })
      )
    )
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          recordFeatureInteraction: recordFeatureInteractionMock,
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.getState().hydratePersistedUI(
      makePersistedUI({
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 2 }
        },
        contextualToursSeenIds: ['tasks']
      })
    )
    setMock.mockClear()

    store.getState().recordFeatureInteraction('tasks')
    await Promise.resolve()

    expect(recordFeatureInteractionMock).toHaveBeenCalledWith('tasks')
    expect(setMock).not.toHaveBeenCalled()
    expect(store.getState().featureInteractions.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 3
    })
    expect(store.getState().contextualToursSeenIds).toEqual(['tasks', 'browser'])
  })

  it('keeps newer optimistic interaction counts when persistence responses resolve out of order', async () => {
    const pending: ((ui: PersistedUIState) => void)[] = []
    const recordFeatureInteractionMock = vi.fn(
      () =>
        new Promise<PersistedUIState>((resolve) => {
          pending.push(resolve)
        })
    )
    vi.stubGlobal('window', {
      api: {
        ui: {
          recordFeatureInteraction: recordFeatureInteractionMock,
          set: vi.fn(() => Promise.resolve())
        }
      }
    })
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI())

    store.getState().recordFeatureInteraction('tasks')
    store.getState().recordFeatureInteraction('tasks')

    pending[1](
      makePersistedUI({
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 2 }
        }
      })
    )
    await Promise.resolve()
    pending[0](
      makePersistedUI({
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 1 }
        }
      })
    )
    await Promise.resolve()

    expect(store.getState().featureInteractions.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 2
    })
  })

  it('does not record interactions before persisted UI has hydrated', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().recordFeatureInteraction('tasks')

    expect(store.getState().featureInteractions).toEqual({})
    expect(setMock).not.toHaveBeenCalled()
  })
})
