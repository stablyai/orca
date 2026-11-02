// @vitest-environment happy-dom

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  automationOnceRunAt,
  buildAutomationOnceSchedule
} from '../../../../shared/automation-once-schedule'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'
import { buildAutomationEditDraft } from './automation-edit-draft'

describe('saving a one-time automation', () => {
  installAutomationsPageHarness()

  async function saveDate(onceDate: string) {
    scopedList([])
    api.automations.list.mockResolvedValue([])
    api.automations.create.mockResolvedValue(makeAutomation({ id: 'once-created' }))
    await renderPage()
    await settleHostQueries()
    await act(async () => mocks.listPanel?.openCreateDialog())
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => {
        if (!current || typeof current !== 'object') {
          throw new Error('Expected an open automation draft')
        }
        return {
          ...current,
          name: 'Run on a date',
          prompt: 'Check the repo',
          projectId: REPO_ID,
          workspaceMode: 'existing',
          workspaceId: WORKSPACE_ID,
          preset: 'once',
          onceDate,
          time: '17:30'
        }
      })
    })
    await act(async () => {
      await mocks.editorDialog?.onSave()
    })
    await settleHostQueries()
  }

  it('sends the selected full date and minute to the storing host', async () => {
    await saveDate('2099-11-02')
    expect(api.automations.create).toHaveBeenCalledOnce()
    expect(api.automations.create.mock.calls[0][0]).toMatchObject({
      name: 'Run on a date',
      rrule: buildAutomationOnceSchedule(automationOnceRunAt('2099-11-02', '17:30')!)
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('blocks a past date before writing to the host', async () => {
    await saveDate('2000-01-01')
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Choose a valid future date and time.')
    expect(mocks.editorDialog?.open).toBe(true)
  })

  it('reopens completed schedules using local date and clock fields', () => {
    const runAt = automationOnceRunAt('2000-01-01', '17:30')!
    const draft = buildAutomationEditDraft(
      makeAutomation({
        rrule: buildAutomationOnceSchedule(runAt),
        enabled: false
      })
    )
    expect(draft).toMatchObject({
      preset: 'once',
      onceDate: '2000-01-01',
      time: '17:30',
      scheduleWarning: null
    })
  })
})
