import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationDraft } from './AutomationEditorDialog'
import {
  AutomationCustomCronPanel,
  getCronFieldValues,
  getCronScheduleStatusLabel
} from './AutomationCustomCronPanel'
import {
  AUTOMATION_SCHEDULE_PRESET_OPTIONS,
  getAutomationSchedulePresetLabel,
  getSchedulePresetDraft
} from './AutomationSchedulePicker'
import { isValidAutomationCronSchedule } from '../../../../shared/automation-schedules'
import { i18n } from '@/i18n/i18n'

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
  // Reset here, not after the assertion: a failed expect would otherwise leak the locale.
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('provides an i18n key for every selectable cadence (#10043)', () => {
    expect(AUTOMATION_SCHEDULE_PRESET_OPTIONS).toContainEqual([
      'custom',
      'Custom cron',
      'auto.components.automations.AutomationSchedulePicker.ddba78647e'
    ])
    for (const [value, fallbackLabel, labelKey] of AUTOMATION_SCHEDULE_PRESET_OPTIONS) {
      expect(value).not.toBe('')
      expect(fallbackLabel).not.toBe('')
      expect(labelKey).toMatch(
        /^auto\.components\.automations\.AutomationSchedulePicker\.[0-9a-f]{10}$/
      )
    }
  })

  it.each([
    ['zh', ['每小时', '每天', '工作日', '每周', '自定义 cron']],
    ['ja', ['毎時', '毎日', '平日', '毎週', 'カスタム cron']],
    ['ko', ['매시간', '매일', '평일', '매주', '사용자 지정 cron']],
    ['es', ['Cada hora', 'Diario', 'Días laborables', 'Semanal', 'Cron personalizado']]
  ])('translates every cadence option in %s', async (locale, labels) => {
    await i18n.changeLanguage(locale)
    expect(AUTOMATION_SCHEDULE_PRESET_OPTIONS.map(getAutomationSchedulePresetLabel)).toEqual(labels)
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
