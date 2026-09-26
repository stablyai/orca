// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultNotificationSettings } from '../../../../shared/constants'
import { WorkspaceNotificationSettings } from './WorkspaceNotificationSettings'

afterEach(cleanup)

it('defaults older settings to on and updates only the selected provenance', () => {
  const settings = getDefaultNotificationSettings()
  delete settings.cliWorktreeTaskComplete
  delete settings.automationWorktreeTaskComplete
  const onUpdate = vi.fn()
  const { rerender } = render(
    <WorkspaceNotificationSettings settings={settings} onUpdate={onUpdate} />
  )
  const cli = screen.getByRole('switch', { name: 'CLI-created Worktrees' })
  const automation = screen.getByRole('switch', { name: 'Automation-created Worktrees' })
  expect(cli.getAttribute('aria-checked')).toBe('true')
  expect(automation.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(cli)
  expect(onUpdate).toHaveBeenLastCalledWith({ cliWorktreeTaskComplete: false })
  fireEvent.click(automation)
  expect(onUpdate).toHaveBeenLastCalledWith({ automationWorktreeTaskComplete: false })
  rerender(
    <WorkspaceNotificationSettings
      settings={{ ...settings, cliWorktreeTaskComplete: false }}
      onUpdate={onUpdate}
    />
  )
  expect(cli.getAttribute('aria-checked')).toBe('false')
  expect(automation.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(cli)
  expect(onUpdate).toHaveBeenLastCalledWith({ cliWorktreeTaskComplete: true })
})

it.each(['enabled', 'agentTaskComplete'] as const)(
  'disables both controls when %s is off',
  (key) => {
    const onUpdate = vi.fn()
    render(
      <WorkspaceNotificationSettings
        settings={{ ...getDefaultNotificationSettings(), [key]: false }}
        onUpdate={onUpdate}
      />
    )
    for (const control of screen.getAllByRole('switch')) {
      expect(control.hasAttribute('disabled')).toBe(true)
      fireEvent.click(control)
    }
    expect(onUpdate).not.toHaveBeenCalled()
  }
)
