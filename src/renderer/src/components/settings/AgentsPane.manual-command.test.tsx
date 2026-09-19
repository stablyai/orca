// @vitest-environment happy-dom
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../ui/tooltip'
import { AgentsPane } from './AgentsPane'

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: [],
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

beforeEach(() => {
  useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
})

afterEach(cleanup)

it('saves and resets an Antigravity command while PATH detection is empty', () => {
  const settings = getDefaultSettings('/tmp')
  const updateSettings = vi.fn()
  const view = render(
    <TooltipProvider>
      <AgentsPane settings={settings} updateSettings={updateSettings} />
    </TooltipProvider>
  )
  const label = view.getByText('Antigravity', { selector: 'span' })
  const row = label.closest('.py-3')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing Antigravity settings row')
  }
  const controls = within(row)
  fireEvent.click(controls.getByRole('button', { name: 'Expand command override' }))
  const command = controls.getByPlaceholderText('agy')
  const customCommand = '"C:\\Agent Tools\\agy.exe"'
  fireEvent.change(command, { target: { value: customCommand } })
  fireEvent.blur(command)
  expect(updateSettings).toHaveBeenCalledWith({
    agentCmdOverrides: { antigravity: customCommand }
  })

  view.rerender(
    <TooltipProvider>
      <AgentsPane
        settings={{ ...settings, agentCmdOverrides: { antigravity: customCommand } }}
        updateSettings={updateSettings}
      />
    </TooltipProvider>
  )
  expect(controls.getByDisplayValue(customCommand)).toBeTruthy()
  fireEvent.click(controls.getByRole('button', { name: /^Reset$/ }))
  expect(updateSettings).toHaveBeenLastCalledWith({ agentCmdOverrides: {} })
  expect(controls.queryByRole('button', { name: /^Set default$/ })).toBeNull()
})
