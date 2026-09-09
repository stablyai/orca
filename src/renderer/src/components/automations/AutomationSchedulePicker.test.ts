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
  AutomationSchedulePicker,
  getAutomationSchedulePresetLabel,
  getSchedulePresetDraft
} from './AutomationSchedulePicker'
import { formatUiAutomationSchedule } from './automation-schedule-label'
import { isValidAutomationCronSchedule } from '../../../../shared/automation-schedule-parsing'
import { SelectItem } from '@/components/ui/select'
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

function collectSelectItems(
  node: React.ReactNode,
  found: [string, string][] = []
): [string, string][] {
  if (!React.isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        collectSelectItems(child, found)
      }
    }
    return found
  }
  const props = node.props as { value?: unknown; children?: React.ReactNode }
  if (node.type === SelectItem && typeof props.value === 'string') {
    found.push([props.value, String(props.children)])
  }
  return collectSelectItems(props.children ?? null, found)
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

  it.each([
    ['zh', '星期日', '星期一'],
    ['ja', '日曜日', '月曜日'],
    ['ko', '일요일', '월요일'],
    ['es', 'domingo', 'lunes']
  ])('translates every weekday option in %s (#14404)', async (locale, sunday, monday) => {
    await i18n.changeLanguage(locale)
    // Radix renders SelectContent only when open, so walk the element tree the picker builds.
    const dayOptions = collectSelectItems(
      AutomationSchedulePicker({
        draft: { ...BASE_DRAFT, preset: 'weekly' },
        validateAdvancedSchedule: isValidAutomationCronSchedule,
        onDraftChange: () => undefined
      })
    ).filter(([value]) => /^[0-6]$/.test(value))

    // Values stay Sunday-indexed '0'..'6' so persisted AutomationDraft.dayOfWeek round-trips.
    expect(dayOptions.map(([value]) => value)).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    expect(dayOptions[0][1]).toBe(sunday)
    expect(dayOptions[1][1]).toBe(monday)
    expect(dayOptions.map(([, label]) => label)).not.toContain('Monday')
  })

  it.each([
    ['zh', '每星期五'],
    ['ja', '毎週金曜日'],
    ['ko', '매주 금요일'],
    ['es', 'Cada viernes']
  ])(
    'localizes the weekly schedule label without an English plural in %s (#14404)',
    async (locale, expected) => {
      await i18n.changeLanguage(locale)
      const label = formatUiAutomationSchedule('0 9 * * 5')

      expect(label).toContain(expected)
      expect(label).not.toMatch(/Friday/)
      expect(label).not.toMatch(/s at /)
    }
  )

  it('localizes the valid-custom-cron status without matching English copy (#14404)', async () => {
    await i18n.changeLanguage('zh')

    expect(getCronScheduleStatusLabel('*/30 9-17 * * 1-5', isValidAutomationCronSchedule)).toEqual({
      kind: 'valid',
      label: '有效的自定义 cron'
    })
    expect(getCronScheduleStatusLabel('0 9 * * *', isValidAutomationCronSchedule).label).toContain(
      '每天'
    )
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
