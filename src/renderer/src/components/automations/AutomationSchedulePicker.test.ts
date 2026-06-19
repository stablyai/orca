import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AutomationDraft } from './AutomationEditorDialog'
import {
  AutomationCustomCronPanel,
  getCronFieldValues,
  getCronScheduleStatusLabel
} from './AutomationCustomCronPanel'
import {
  AUTOMATION_SCHEDULE_PRESET_OPTIONS,
  getSchedulePresetDraft
} from './AutomationSchedulePicker'
import { isValidAutomationCronSchedule } from '../../../../shared/automation-schedules'

const BASE_DRAFT: AutomationDraft = {
  name: '',
  prompt: '',
  agentId: 'codex',
  projectId: '',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '30',
  preset: 'weekdays',
  time: '09:15',
  dayOfWeek: '1',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  scheduleWarning: null
}

describe('AutomationSchedulePicker', () => {
  it('offers custom cron as a selectable cadence', () => {
    expect(AUTOMATION_SCHEDULE_PRESET_OPTIONS).toContainEqual(['custom', 'Custom cron'])
  })

  it('seeds custom cron from the current simple schedule', () => {
    expect(getSchedulePresetDraft(BASE_DRAFT, 'custom')).toMatchObject({
      preset: 'custom',
      customSchedule: '15 9 * * 1-5',
      scheduleWarning: null
    })
  })

  it('preserves an existing custom cron when toggling back to custom', () => {
    expect(
      getSchedulePresetDraft({ ...BASE_DRAFT, customSchedule: '*/30 9-17 * * 1-5' }, 'custom')
    ).toMatchObject({
      preset: 'custom',
      customSchedule: '*/30 9-17 * * 1-5'
    })
  })

  it('summarizes custom cron validity for the inline status row', () => {
    expect(getCronScheduleStatusLabel('', isValidAutomationCronSchedule)).toEqual({
      kind: 'empty',
      label: 'Enter a five-field cron.'
    })
    expect(getCronScheduleStatusLabel('not cron', isValidAutomationCronSchedule)).toEqual({
      kind: 'invalid',
      label: 'Enter a valid five-field cron before saving.'
    })
    expect(getCronScheduleStatusLabel('0 9 * * 1-5', isValidAutomationCronSchedule)).toMatchObject({
      kind: 'valid'
    })
  })

  it('splits cron expressions into labeled field values', () => {
    expect(getCronFieldValues('0 9 * * 1-5')).toEqual(['0', '9', '*', '*', '1-5'])
    expect(getCronFieldValues('0 9')).toEqual(['0', '9', '...', '...', '...'])
  })

  it('renders the cron expression field without quick starts', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AutomationCustomCronPanel, {
        draft: { ...BASE_DRAFT, preset: 'custom', customSchedule: '0 9 * * 1-5' },
        customScheduleInvalid: false,
        validateAdvancedSchedule: isValidAutomationCronSchedule,
        onDraftChange: () => undefined
      })
    )

    expect(markup).not.toContain('Quick starts')
    expect(markup).not.toContain('Every 15 min')
    expect(markup).toContain('Cron expression')
    expect(markup).toContain('Minute')
    expect(markup).toContain('Weekday')
    expect(markup).toContain('automation-cron-status')
  })
})
