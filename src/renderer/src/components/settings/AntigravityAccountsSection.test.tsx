// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AntigravityAccountsSection } from './AntigravityAccountsSection'

vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => <span /> }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settingsSearchQuery: '', refreshRateLimits: vi.fn() })
}))
afterEach(cleanup)

it.each([false, true])('lets users change the Gemini opt-in from %s', (enabled) => {
  const updateSettings = vi.fn()
  render(
    <AntigravityAccountsSection
      model={{
        settings: { ...getDefaultSettings('/tmp'), geminiCliOAuthEnabled: enabled },
        updateSettings,
        recordFeatureInteraction: vi.fn(),
        localAccountRuntimeSentenceLabel: 'this device',
        searchQuery: ''
      }}
    />
  )
  if (!enabled) {
    fireEvent.click(screen.getByText('Use Gemini CLI credentials'))
  }
  fireEvent.click(screen.getByRole('switch', { name: 'Use Gemini CLI credentials (experimental)' }))
  expect(updateSettings).toHaveBeenCalledWith({ geminiCliOAuthEnabled: !enabled })
})

it.each([false, true])(
  'restores the user expansion state (%s) after clearing search',
  (expanded) => {
    const model = {
      settings: { ...getDefaultSettings('/tmp'), geminiCliOAuthEnabled: false },
      updateSettings: vi.fn(),
      recordFeatureInteraction: vi.fn(),
      localAccountRuntimeSentenceLabel: 'this device',
      searchQuery: ''
    }
    const view = render(<AntigravityAccountsSection model={model} />)
    const summary = screen.getByText('Use Gemini CLI credentials')
    const panel = summary.closest('details')
    if (expanded) {
      fireEvent.click(summary)
    }
    expect(panel?.open).toBe(expanded)
    view.rerender(<AntigravityAccountsSection model={{ ...model, searchQuery: 'credentials' }} />)
    expect(panel?.open).toBe(true)
    if (panel) {
      fireEvent(panel, new Event('toggle'))
    }
    view.rerender(<AntigravityAccountsSection model={model} />)
    expect(panel?.open).toBe(expanded)
    fireEvent.click(summary)
    expect(panel?.open).toBe(!expanded)
  }
)
