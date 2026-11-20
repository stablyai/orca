import { describe, expect, it, vi } from 'vitest'
import { makeAutomation } from '../automations-page-fixtures'
import { buildAutomationEditDraft } from './automation-edit-draft'
import type { AutomationSaveContext } from './automation-save-context'

const mocks = vi.hoisted(() => ({
  saveExistingAutomation: vi.fn(),
  reread: vi.fn()
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../hosts/automation-host-client', () => ({ listAutomationsForTarget: vi.fn() }))
vi.mock('../hosts/automation-row-action-dispatch', () => ({
  dispatchAutomationReread: mocks.reread
}))
vi.mock('./automation-setup-review', () => ({
  confirmAutomationSaveSetup: async () => ({ trust: null, setupTrustHash: undefined })
}))
vi.mock('./automation-save-completion', () => ({ completeAutomationSave: vi.fn() }))
vi.mock('./automation-orca-save-operations', () => ({
  createAutomationOnDestination: vi.fn(),
  moveAutomationToDestination: vi.fn(),
  resolveAutomationEditDestination: () => ({
    ok: true,
    editDestination: undefined,
    moveTarget: null
  }),
  saveExistingAutomation: mocks.saveExistingAutomation
}))

const { saveOrcaAutomation } = await import('./automation-orca-save')

describe('saveOrcaAutomation', () => {
  it('renames an automation whose saved rule is refused without resending its schedule', async () => {
    const automation = makeAutomation({ rrule: 'FREQ=DAILY;UNTIL=20271231T000000Z' })
    mocks.reread.mockResolvedValue({ ok: true, value: automation })
    mocks.saveExistingAutomation.mockResolvedValue({ ok: false, notice: null })
    const draftAtOpen = buildAutomationEditDraft(automation)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields this edit path reads are filled; the rest is mocked above
    const context = {
      store: { projectHostSetups: [] },
      local: {
        draft: { ...draftAtOpen, name: 'Renamed' },
        draftAtOpen,
        editingAutomationId: automation.id,
        editingRowKey: 'row-1',
        targetEdited: false,
        setEditorNotice: vi.fn(),
        setEditorNoticeHost: vi.fn(),
        moveCreationKeysRef: { current: new Map() }
      },
      list: { capturedAutomationOwners: new Map() },
      setup: {},
      destination: {
        automationHostTarget: { kind: 'local' },
        automationDispatchContext: {},
        invalidateWrittenHost: vi.fn(),
        rowRecoveryHost: () => null,
        createDestination: { check: vi.fn() }
      },
      destinationForm: {
        dialogRepos: [],
        editHostResolution: null,
        automationDialogTarget: null,
        editingDestination: null,
        editHostEntries: []
      },
      pageRefresh: {}
    } as unknown as AutomationSaveContext

    await saveOrcaAutomation(context, { hour: 9, minute: 0, now: 1, surface: 'terminal' })

    expect(mocks.saveExistingAutomation).toHaveBeenCalledOnce()
    const updates = mocks.saveExistingAutomation.mock.calls[0][3]
    expect(updates).toEqual({ name: 'Renamed' })
  })
})
