// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'

// Why: Radix Select needs pointer/layout APIs happy-dom lacks; a native select keeps value testable.
vi.mock('../../../ui/select', () => ({
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

import { ClaudeRunningSessionSwitchSetting } from './claude-running-session-switch-setting'

afterEach(cleanup)

it('saves the choice to restart every session on a switch', () => {
  const updateSettings = vi.fn()
  render(
    <ClaudeRunningSessionSwitchSetting
      settings={getDefaultSettings('/home/dev')}
      updateSettings={updateSettings}
    />
  )

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'restart-all' } })

  expect(updateSettings).toHaveBeenCalledWith({ claudeAccountSwitchRunningSessions: 'restart-all' })
})
