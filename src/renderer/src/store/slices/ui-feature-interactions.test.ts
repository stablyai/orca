import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'

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
})
