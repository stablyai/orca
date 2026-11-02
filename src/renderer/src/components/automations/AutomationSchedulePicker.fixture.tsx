import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { i18n } from '@/i18n/i18n'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'

function OnceScheduleFixture({ date = '2099-11-02' }: { date?: string }) {
  const [draft, setDraft] = useState<AutomationDraft>({
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
    precheckTimeoutSeconds: '60',
    preset: 'once',
    onceDate: date,
    time: '17:30',
    dayOfWeek: '1',
    customSchedule: '',
    savedSchedule: null,
    missedRunGraceMinutes: '720',
    scheduleWarning: null
  })
  return (
    <div className="p-4">
      <AutomationSchedulePicker draft={draft} onDraftChange={setDraft} />
    </div>
  )
}

export const once = defineFixture({
  width: 300,
  render: () => <OnceScheduleFixture />,
  interact: async () => {
    await i18n.changeLanguage('zh')
  }
})

export const past = defineFixture({
  width: 300,
  render: () => <OnceScheduleFixture date="2000-01-01" />,
  interact: async () => {
    await i18n.changeLanguage('zh')
  }
})
