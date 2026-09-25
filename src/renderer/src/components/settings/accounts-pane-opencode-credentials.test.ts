// @vitest-environment happy-dom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeGoCredentials } from './accounts-pane-opencode-credentials'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('OpenCode Go credentials setting', () => {
  it('shows saved status without reading a key, saves a draft, and clears it', async () => {
    const getStatus = vi.fn(async () => ({ apiKeyConfigured: true }))
    const saveApiKey = vi.fn(async () => ({ apiKeyConfigured: true }))
    const clearApiKey = vi.fn(async () => ({ apiKeyConfigured: false }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        opencodeGoCredentials: { getStatus, saveApiKey, clearApiKey }
      }
    })
    const onSaved = vi.fn()
    render(createElement(OpenCodeGoCredentials, { onSaved }))
    await screen.findByText('Saved')
    const input = screen.getByLabelText('OpenCode Go API key')
    expect(input).toBeInstanceOf(HTMLInputElement)
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Missing credential input')
    }
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'fake-new-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(saveApiKey).toHaveBeenCalledWith('fake-new-key'))
    await waitFor(() => expect(input.value).toBe(''))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await screen.findByText('Not saved')
    expect(clearApiKey).toHaveBeenCalledOnce()
    expect(onSaved).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })
})
