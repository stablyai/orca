// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeGoCredentials } from './accounts-pane-opencode-credentials'

vi.mock('../../../../store/index', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OpenCode Go credentials setting', () => {
  it('keeps a saved status when the initial read resolves afterward', async () => {
    const initialStatus = Promise.withResolvers<{ apiKeyConfigured: boolean }>()
    const getStatus = vi.fn(() => initialStatus.promise)
    const saveApiKey = vi.fn(async () => ({ apiKeyConfigured: true }))
    const clearApiKey = vi.fn(async () => ({ apiKeyConfigured: false }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        opencodeGoCredentials: { getStatus, saveApiKey, clearApiKey }
      }
    })

    render(createElement(OpenCodeGoCredentials, { onSaved: vi.fn() }))
    const input = screen.getByLabelText('OpenCode Go API key')
    fireEvent.change(input, { target: { value: 'fake-new-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('Saved')
    await act(async () => {
      initialStatus.resolve({ apiKeyConfigured: false })
      await Promise.resolve()
    })

    expect(screen.getByText('Saved')).toBeTruthy()
  })
})
