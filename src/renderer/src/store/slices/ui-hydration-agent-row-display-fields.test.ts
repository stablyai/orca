import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRowDisplayField } from '../../../../shared/ui-chrome-types'
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

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test input exercises filtering of invalid display field values.
    const invalidFields = ['model', 'bogus', 'provider-icon'] as AgentRowDisplayField[]
    store.getState().setAgentRowDisplayFields(invalidFields)

    expect(store.getState().agentRowDisplayFields).toEqual(['provider-icon', 'model'])
    expect(setUI).toHaveBeenCalledWith({ agentRowDisplayFields: ['provider-icon', 'model'] })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test input exercises unknown field filtering in persisted storage hydration.
    const fieldsWithUnknownToken = ['relative-time', 'nope'] as AgentRowDisplayField[]
    store.getState().hydratePersistedUI(
      makePersistedUI({
        agentRowDisplayFields: fieldsWithUnknownToken
      })
    )
    expect(store.getState().agentRowDisplayFields).toEqual(['relative-time'])
  })

  it('hydrates absent fields to the all-on default', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({}))

    expect(store.getState().agentRowDisplayFields).toEqual([
      'provider-icon',
      'secondary-status',
      'model',
      'relative-time'
    ])
  })
})
