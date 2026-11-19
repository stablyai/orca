// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotItemSnoozeDialog } from './BotItemSnoozeDialog'

const priorTz = process.env.TZ
beforeEach(() => {
  process.env.TZ = 'UTC'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-11-18T10:07:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (priorTz === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = priorTz
  }
})

function openPicker(): ReturnType<typeof vi.fn> {
  const onSnooze = vi.fn()
  render(<BotItemSnoozeDialog open onSnooze={onSnooze} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Pick a date and time' }))
  return onSnooze
}

it('defaults to tomorrow at 9 AM and rolls a past time forward when today is picked', () => {
  const onSnooze = openPicker()
  expect(screen.getByRole('button', { name: 'Snooze', description: /^Thu 9:00\sAM$/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Tuesday, November 17' })).toHaveProperty(
    'disabled',
    true
  )
  fireEvent.click(screen.getByRole('button', { name: 'Wednesday, November 18' }))
  fireEvent.click(screen.getByRole('button', { name: 'Snooze', description: /^10:15\sAM$/ }))
  expect(onSnooze).toHaveBeenCalledWith(Date.parse('2026-11-18T10:15:00Z'))
})

it('moves calendar focus with the arrow keys and submits the selected date', () => {
  const onSnooze = openPicker()
  const start = screen.getByRole('button', { name: 'Thursday, November 19' })
  expect(start.tabIndex).toBe(0)
  start.focus()
  fireEvent.keyDown(start, { key: 'ArrowDown' })
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Thursday, November 26')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Wednesday, November 25')
  fireEvent.click(document.activeElement!)
  fireEvent.click(screen.getByRole('button', { name: 'Snooze' }))
  expect(onSnooze).toHaveBeenCalledWith(Date.parse('2026-11-25T09:00:00Z'))
})
