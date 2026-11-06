// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { UsageBreakdownSection, type UsageBreakdownRow } from './UsageBreakdownSection'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

function row(key: string, sessions: number, eventsOrTurns: number): UsageBreakdownRow {
  return { key, label: key, tokens: 0, sessions, eventsOrTurns }
}

it('picks each Russian plural form for session and turn counts', async () => {
  await i18n.changeLanguage('ru')
  render(
    <UsageBreakdownSection
      title="title"
      topLabel="top"
      topValue="model"
      eventsOrTurns="turns"
      rows={[row('a', 1, 21), row('b', 3, 5), row('c', 11, 2)]}
    />
  )
  expect(screen.getByText('1 сессия • 21 ответ')).toBeTruthy()
  expect(screen.getByText('3 сессии • 5 ответов')).toBeTruthy()
  expect(screen.getByText('11 сессий • 2 ответа')).toBeTruthy()
})
