import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationDraft } from './AutomationEditorDialog'

import { getSchedulePresetDraft } from './AutomationSchedulePicker'

import { i18n } from '@/i18n/i18n'

const BASE_DRAFT: AutomationDraft = {
  name: '',
  prompt: '',
  agentId: 'codex',
  extraAgentArgs: '',
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
  savedSchedule: null,
  scheduleWarning: null
}

describe('AutomationSchedulePicker', () => {
  // Reset here, not after the assertion: a failed expect would otherwise leak the locale.
  afterEach(async () => {
    await i18n.changeLanguage('en')
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
})
