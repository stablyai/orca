// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'
import { isValidAutomationCronSchedule } from '../../../../shared/automation-schedule-parsing'
import { useTranslation } from 'react-i18next'
import { i18n } from '@/i18n/i18n'

// Why: Radix Select mounts its content in a portal only once opened; the native swap keeps the
// weekday options in the document so these assertions read real DOM text, not a React element tree.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

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
  preset: 'weekly',
  time: '09:15',
  dayOfWeek: '5',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  scheduleWarning: null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => {
    root.unmount()
  })
  container.remove()
  // Reset here, not after the assertion: a failed expect would otherwise leak the locale.
  await i18n.changeLanguage('en')
})

// Mirrors main.tsx: the picker calls translate() directly, so a root-level useTranslation() is
// what re-renders it after an in-place language switch.
function LanguageAwarePicker({ draft }: { draft: AutomationDraft }): React.JSX.Element {
  useTranslation()
  return React.createElement(AutomationSchedulePicker, {
    draft,
    validateAdvancedSchedule: isValidAutomationCronSchedule,
    onDraftChange: () => undefined
  })
}

function renderPicker(draft: Partial<AutomationDraft>): void {
  act(() => {
    root.render(React.createElement(LanguageAwarePicker, { draft: { ...BASE_DRAFT, ...draft } }))
  })
}

function renderedWeekdayOptions(): { value: string; text: string }[] {
  return Array.from(container.querySelectorAll('option'))
    .filter((option) => /^[0-6]$/.test(option.value))
    .map((option) => ({ value: option.value, text: option.textContent ?? '' }))
}

function renderedCronFieldChips(): { text: string; title: string }[] {
  const grid = container.querySelector('.grid-cols-5')
  return Array.from(grid?.children ?? []).map((chip) => ({
    text: chip.firstElementChild?.textContent ?? '',
    title: chip.firstElementChild?.getAttribute('title') ?? ''
  }))
}

describe('AutomationSchedulePicker rendered DOM (#14404)', () => {
  it.each([
    ['zh', ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']],
    ['ja', ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日']],
    ['ko', ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']],
    ['es', ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']]
  ])('renders the Day dropdown in %s', async (locale, expectedNames) => {
    await i18n.changeLanguage(locale)
    renderPicker({ preset: 'weekly' })

    const options = renderedWeekdayOptions()
    // Values stay Sunday-indexed '0'..'6' so persisted AutomationDraft.dayOfWeek round-trips.
    expect(options.map((option) => option.value)).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    expect(options.map((option) => option.text)).toEqual(expectedNames)
    expect(container.textContent).not.toContain('Monday')
  })

  it('renders English weekday names when the UI language is English', () => {
    renderPicker({ preset: 'weekly' })

    expect(renderedWeekdayOptions().map((option) => option.text)).toEqual([
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday'
    ])
  })

  it('relabels the mounted Day dropdown when the language changes in place', async () => {
    renderPicker({ preset: 'weekly' })
    expect(renderedWeekdayOptions().map((option) => option.text)).toContain('Sunday')

    await act(async () => {
      await i18n.changeLanguage('ja')
    })

    const options = renderedWeekdayOptions()
    // Item identity keys off the stable index, so the values survive the locale swap.
    expect(options.map((option) => option.value)).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    expect(options.map((option) => option.text)).toEqual([
      '日曜日',
      '月曜日',
      '火曜日',
      '水曜日',
      '木曜日',
      '金曜日',
      '土曜日'
    ])
    expect(container.textContent).not.toContain('Sunday')
  })

  it('renders the weekly cron status row localized, with no English plural (#14404)', async () => {
    await i18n.changeLanguage('zh')
    renderPicker({ preset: 'custom', customSchedule: '0 9 * * 5' })

    expect(container.textContent).toContain('每星期五')
    expect(container.textContent).not.toContain('Friday')
    expect(container.textContent).not.toMatch(/s at /)
  })

  it('renders the valid-custom-cron status row localized (#14404)', async () => {
    await i18n.changeLanguage('zh')
    renderPicker({ preset: 'custom', customSchedule: '*/30 9-17 * * 1-5' })

    expect(container.textContent).toContain('有效的自定义 cron')
  })

  it.each([
    ['zh', ['分钟', '小时', '日', '月', '星期']],
    ['ja', ['分', '時間', '日', '月', '曜日']],
    ['ko', ['분', '시간', '일', '월', '요일']],
    ['es', ['Minuto', 'Hora', 'Día', 'Mes', 'Día de la semana']]
  ])('renders the custom-cron field chips in %s (#14404)', async (locale, expectedLabels) => {
    await i18n.changeLanguage(locale)
    renderPicker({ preset: 'custom', customSchedule: '0 9 * * 1-5' })

    const chips = renderedCronFieldChips()
    expect(chips.map((chip) => chip.text)).toEqual(expectedLabels)
    // The chip is `truncate`d, so the full header has to stay reachable on hover.
    expect(chips.map((chip) => chip.title)).toEqual(expectedLabels)
    expect(container.textContent).not.toContain('Weekday')
  })

  it('renders English cron field chips when the UI language is English', () => {
    renderPicker({ preset: 'custom', customSchedule: '0 9 * * 1-5' })

    expect(renderedCronFieldChips().map((chip) => chip.text)).toEqual([
      'Minute',
      'Hour',
      'Day',
      'Month',
      'Weekday'
    ])
  })
})
