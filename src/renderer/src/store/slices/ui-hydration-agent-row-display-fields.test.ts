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

describe('createUISlice agent row display fields', () => {
  it('persists and normalizes agent row display fields', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setAgentRowDisplayFields(['model', 'bogus' as never, 'provider-icon'])

    expect(store.getState().agentRowDisplayFields).toEqual(['provider-icon', 'model'])
    expect(setUI).toHaveBeenCalledWith({ agentRowDisplayFields: ['provider-icon', 'model'] })

    store.getState().hydratePersistedUI(
      makePersistedUI({
        agentRowDisplayFields: ['relative-time', 'nope' as never]
      })
    )
    expect(store.getState().agentRowDisplayFields).toEqual(['relative-time'])
  })

  it('hydrates absent fields to the all-on default', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        agentRowDisplayFields: undefined
      } as Partial<PersistedUIState>)
    )

    expect(store.getState().agentRowDisplayFields).toEqual([
      'provider-icon',
      'secondary-status',
      'model',
      'relative-time'
    ])
  })
})
