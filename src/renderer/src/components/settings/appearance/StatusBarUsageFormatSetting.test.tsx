// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBarUsageFormatSetting } from './StatusBarUsageFormatSetting'

vi.mock('../../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

describe('StatusBarUsageFormatSetting', () => {
  afterEach(() => {
    cleanup()
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

  it('resets to the built-in format', () => {
    const onChange = vi.fn()
    render(<StatusBarUsageFormatSetting format={{ template: '{5h}' }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onChange).toHaveBeenLastCalledWith({ template: '' })
  })
})
