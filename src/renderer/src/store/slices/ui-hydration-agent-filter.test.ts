import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('createUISlice hydratePersistedUI agent filter', () => {
  it('restores the multi-id agent filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        filterAgentIds: ['openclaude', 'codex']
      })
    )

    expect(store.getState().filterAgentIds).toEqual(['openclaude', 'codex'])
  })

  it('hydrates leftover singular filterAgentId onto a one-id list', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        filterAgentIds: undefined,
        filterAgentId: 'openclaude'
      })
    )

    expect(store.getState().filterAgentIds).toEqual(['openclaude'])
  })

  it('migrates leftover cc/codex harness values onto catalog agent lists', () => {
    const leftoverCc = createUIStore()
    leftoverCc.getState().hydratePersistedUI(
      makePersistedUI({
        filterAgentIds: undefined,
        filterAgentId: undefined,
        filterHarnessId: 'cc'
      })
    )
    expect(leftoverCc.getState().filterAgentIds).toEqual(['claude'])

    const leftoverCodex = createUIStore()
    leftoverCodex.getState().hydratePersistedUI(
      makePersistedUI({
        filterAgentIds: undefined,
        filterAgentId: undefined,
        filterHarnessId: 'codex'
      })
    )
    expect(leftoverCodex.getState().filterAgentIds).toEqual(['codex'])
  })

  it('ignores leftover singular/harness values once filterAgentIds has been persisted', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        filterAgentIds: null,
        filterAgentId: 'claude',
        filterHarnessId: 'cc'
      })
    )

    expect(store.getState().filterAgentIds).toBeNull()
  })

  it('ignores unknown persisted agent filter values', () => {
    const store = createUIStore()

    const unknownFilterUi = makePersistedUI({})
    Object.assign(unknownFilterUi, { filterAgentIds: ['not-an-agent'] })
    store.getState().hydratePersistedUI(unknownFilterUi)

    expect(store.getState().filterAgentIds).toBeNull()
  })
})
