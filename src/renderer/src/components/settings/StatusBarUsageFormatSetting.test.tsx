// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBarUsageFormatSetting } from './StatusBarUsageFormatSetting'
import { getStatusBarEntries } from './appearance-search'
import { getStatusBarUsageFormatEntry } from './appearance-status-bar-usage-format-search'
import { matchesSettingsSearch } from './settings-search'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

describe('StatusBarUsageFormatSetting', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the current template and a preview rendered from sample data', () => {
    render(
      <StatusBarUsageFormatSetting
        format={{ template: '{provider} | 5h: {5h}[ | Fable: {fable}]' }}
        onChange={vi.fn()}
      />
    )
    const input = screen.getByRole('textbox', { name: 'Usage format' }) as HTMLInputElement
    expect(input.value).toBe('{provider} | 5h: {5h}[ | Fable: {fable}]')
    expect(screen.getByText('Claude | 5h: 14% | Fable: 37%')).toBeTruthy()
  })

  it('writes template edits while keeping provider overrides', () => {
    const onChange = vi.fn()
    render(
      <StatusBarUsageFormatSetting
        format={{ template: 'old', byProvider: { codex: '{plan}' } }}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Usage format' }), {
      target: { value: '{7d}' }
    })
    expect(onChange).toHaveBeenLastCalledWith({ template: '{7d}', byProvider: { codex: '{plan}' } })
  })

  it('explains that an empty template keeps the built-in format and offers no reset', () => {
    render(<StatusBarUsageFormatSetting format={{ template: '' }} onChange={vi.fn()} />)
    expect(screen.getByText(/built-in format/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull()
  })

  it('resets to the built-in format', () => {
    const onChange = vi.fn()
    render(<StatusBarUsageFormatSetting format={{ template: '{5h}' }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onChange).toHaveBeenLastCalledWith({ template: '' })
  })

  it('is indexed for Appearance search under the status bar entries', () => {
    const entry = getStatusBarUsageFormatEntry()
    expect(getStatusBarEntries()).toContainEqual(entry)
    for (const query of ['format', 'template', 'status bar', 'usage']) {
      expect(matchesSettingsSearch(query, entry)).toBe(true)
    }
  })
})
