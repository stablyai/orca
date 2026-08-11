// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  openAutomationsPage: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openAutomationsPage: mocks.openAutomationsPage })
}))

import { AutomationsSettingsPane } from './AutomationsSettingsPane'

describe('AutomationsSettingsPane', () => {
  beforeEach(() => {
    mocks.openAutomationsPage.mockReset()
  })

  afterEach(cleanup)

  it('explains the scheduled agent workflow', () => {
    render(
      <AutomationsSettingsPane
        settings={{ ...getDefaultSettings('/tmp'), showAutomationsButton: true }}
        updateSettings={vi.fn()}
      />
    )

    expect(screen.getByText('How Automations work')).toBeInTheDocument()
    expect(screen.getByText('Describe the work')).toBeInTheDocument()
    expect(screen.getByText('Orca starts each run')).toBeInTheDocument()
    expect(screen.getByText('Review the results')).toBeInTheDocument()
    expect(screen.getByText('Create schedules and inspect recent runs.')).toBeInTheDocument()
  })

  it('controls sidebar visibility and opens Automations', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    render(
      <AutomationsSettingsPane
        settings={{ ...getDefaultSettings('/tmp'), showAutomationsButton: false }}
        updateSettings={updateSettings}
      />
    )

    const toggle = screen.getByRole('switch', { name: 'Show Automations Button' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ showAutomationsButton: true })

    const openButton = screen.getByRole('button', { name: /Open Automations/ })
    expect(openButton).toBeEnabled()
    await user.click(openButton)
    expect(mocks.openAutomationsPage).toHaveBeenCalledOnce()
  })
})
