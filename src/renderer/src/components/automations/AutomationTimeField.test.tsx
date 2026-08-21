// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutomationTimeField,
  formatAutomationTimeFromClockParts,
  formatAutomationTimeInput,
  getAutomationClockParts,
  parseAutomationTime,
  resolveDigitCommit,
  resolveDigitStep
} from './AutomationTimeField'

afterEach(() => {
  cleanup()
})

describe('AutomationTimeField helpers', () => {
  it('parses and formats 24h time values', () => {
    expect(parseAutomationTime('09:15')).toEqual({ hour: 9, minute: 15 })
    expect(parseAutomationTime('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseAutomationTime('bad')).toEqual({ hour: 9, minute: 0 })
    expect(formatAutomationTimeInput(9, 5)).toBe('09:05')
    expect(formatAutomationTimeInput(0, 0)).toBe('00:00')
  })

  it('converts between 12h clock parts and 24h storage', () => {
    expect(getAutomationClockParts('00:05')).toEqual({ hour12: 12, minute: 5, period: 'AM' })
    expect(getAutomationClockParts('13:30')).toEqual({ hour12: 1, minute: 30, period: 'PM' })
    expect(getAutomationClockParts('12:00')).toEqual({ hour12: 12, minute: 0, period: 'PM' })
    expect(formatAutomationTimeFromClockParts({ hour12: 12, minute: 5, period: 'AM' })).toBe(
      '00:05'
    )
    expect(formatAutomationTimeFromClockParts({ hour12: 1, minute: 30, period: 'PM' })).toBe(
      '13:30'
    )
    expect(formatAutomationTimeFromClockParts({ hour12: 12, minute: 0, period: 'PM' })).toBe(
      '12:00'
    )
  })

  it('resolves digit commits with empty → min and range clamp', () => {
    expect(resolveDigitCommit('', 9, 1, 12)).toBe(1)
    expect(resolveDigitCommit('', 15, 0, 59)).toBe(0)
    expect(resolveDigitCommit('9', 1, 1, 12)).toBe(9)
    expect(resolveDigitCommit('00', 9, 1, 12)).toBe(1)
    expect(resolveDigitCommit('24', 9, 0, 23)).toBe(23)
    expect(resolveDigitCommit('99', 15, 0, 59)).toBe(59)
    expect(resolveDigitCommit('abc', 15, 0, 59)).toBe(15)
  })

  it('steps from in-progress text rather than only the committed value', () => {
    expect(resolveDigitStep('1', 9, 1, 12, 1)).toBe(2)
    // At the min bound, down wraps to max.
    expect(resolveDigitStep('1', 9, 1, 12, -1)).toBe(12)
    expect(resolveDigitStep('', 9, 1, 12, 1)).toBe(10)
    expect(resolveDigitStep('12', 12, 1, 12, 1)).toBe(1)
    expect(resolveDigitStep('0', 0, 0, 59, -1)).toBe(59)
  })
})

function ControlledTimeField({
  initialTime = '09:15',
  mode = 'time',
  onTimeChange
}: {
  initialTime?: string
  mode?: 'time' | 'minute'
  onTimeChange?: (time: string) => void
}): React.JSX.Element {
  const [time, setTime] = React.useState(initialTime)
  return (
    <AutomationTimeField
      time={time}
      mode={mode}
      onTimeChange={(next) => {
        setTime(next)
        onTimeChange?.(next)
      }}
    />
  )
}

describe('AutomationTimeField interactions', () => {
  it('renders a unified 12h field with AM/PM instead of nested selects', () => {
    render(<ControlledTimeField initialTime="13:15" />)

    expect(screen.getByLabelText('Hour')).toHaveValue('1')
    expect(screen.getByLabelText('Minute')).toHaveValue('15')
    expect(screen.getByRole('button', { name: /^AM or PM:/ })).toHaveTextContent('PM')
    expect(document.querySelector('[data-slot="select"]')).toBeNull()
  })

  it('names the selected period for assistive technology', async () => {
    const user = userEvent.setup()
    render(<ControlledTimeField initialTime="01:15" />)

    const period = screen.getByRole('button', { name: 'AM or PM: AM' })
    expect(period).toHaveAttribute('aria-pressed', 'false')

    await user.click(period)

    expect(screen.getByRole('button', { name: 'AM or PM: PM' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('renders minute-only mode for hourly cadence', () => {
    render(<ControlledTimeField mode="minute" />)

    expect(screen.getByLabelText('Minute')).toHaveValue('15')
    expect(screen.queryByLabelText('Hour')).toBeNull()
    expect(screen.queryByRole('button', { name: /^AM or PM:/ })).toBeNull()
  })

  it('commits typed hour/minute and toggles AM/PM into 24h storage', async () => {
    const user = userEvent.setup()
    const onTimeChange = vi.fn()
    render(<ControlledTimeField onTimeChange={onTimeChange} />)

    const hour = screen.getByLabelText('Hour')
    await user.clear(hour)
    await user.type(hour, '11')
    expect(onTimeChange).toHaveBeenLastCalledWith('11:15')

    onTimeChange.mockClear()
    const minute = screen.getByLabelText('Minute')
    await user.clear(minute)
    await user.type(minute, '05')
    expect(onTimeChange).toHaveBeenLastCalledWith('11:05')

    onTimeChange.mockClear()
    await user.click(screen.getByRole('button', { name: /^AM or PM:/ }))
    expect(onTimeChange).toHaveBeenLastCalledWith('23:05')
    expect(screen.getByRole('button', { name: /^AM or PM:/ })).toHaveTextContent('PM')
  })

  it('treats empty blur as min and does not re-fire after 2-digit auto-commit', async () => {
    const user = userEvent.setup()
    const onTimeChange = vi.fn()
    render(<ControlledTimeField onTimeChange={onTimeChange} />)

    const minute = screen.getByLabelText('Minute')
    await user.clear(minute)
    await user.tab()
    expect(onTimeChange).toHaveBeenLastCalledWith('09:00')
    expect(minute).toHaveValue('00')

    onTimeChange.mockClear()
    await user.click(minute)
    await user.clear(minute)
    await user.type(minute, '30')
    // 2-digit entry auto-commits once; blur must not emit a second identical update.
    const callsAfterType = onTimeChange.mock.calls.length
    expect(onTimeChange).toHaveBeenLastCalledWith('09:30')
    await user.tab()
    expect(onTimeChange.mock.calls.length).toBe(callsAfterType)
  })

  it('arrow-steps from the in-progress digit, not only the last commit', async () => {
    const user = userEvent.setup()
    const onTimeChange = vi.fn()
    render(<ControlledTimeField onTimeChange={onTimeChange} />)

    const hour = screen.getByLabelText('Hour')
    await user.clear(hour)
    await user.type(hour, '1')
    onTimeChange.mockClear()
    await user.keyboard('{ArrowUp}')
    expect(onTimeChange).toHaveBeenLastCalledWith('02:15')
  })
})
