// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCanvasAgentMenu } from './AgentCanvasAgentMenu'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openSettingsTarget: vi.fn(), openSettingsPage: vi.fn() }) }
}))
afterEach(cleanup)

it('uses the Orca picker and launches the selected CLI in one selection', () => {
  const onLaunch = vi.fn()
  const view = render(
    <AgentCanvasAgentMenu
      agents={[]}
      options={[
        { agent: 'codex', label: 'Codex', aliases: [] },
        { agent: 'claude', label: 'Claude', aliases: [] }
      ]}
      disabled={false}
      onLaunch={onLaunch}
      onAttach={vi.fn()}
    />
  )
  const trigger = view.getByRole('combobox', { name: 'New agent' })
  expect(trigger.getAttribute('data-agent-combobox-root')).toBe('true')
  fireEvent.click(trigger)
  expect(view.queryByRole('option', { name: 'Blank Terminal' })).toBeNull()
  expect(view.getByRole('button', { name: 'Manage agents' })).toBeTruthy()
  fireEvent.click(view.getByRole('option', { name: 'Codex' }))
  expect(onLaunch).toHaveBeenCalledExactlyOnceWith('codex')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it('disables the picker while a launch is pending', () => {
  const view = render(
    <AgentCanvasAgentMenu agents={[]} options={[]} disabled onLaunch={vi.fn()} onAttach={vi.fn()} />
  )
  expect(view.getByRole('combobox', { name: 'New agent' }).closest('fieldset')?.disabled).toBe(true)
})
