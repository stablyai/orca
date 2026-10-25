// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeGoCredentials } from './accounts-pane-opencode-credentials'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OpenCode Go credentials setting', () => {
  it('keeps status unconfirmed while the initial read is pending', () => {
    const initialStatus = Promise.withResolvers<{ apiKeyConfigured: boolean }>()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        opencodeGoCredentials: {
          getStatus: vi.fn(() => initialStatus.promise),
          saveApiKey: vi.fn(),
          clearApiKey: vi.fn()
        }
      }
    })

    render(createElement(OpenCodeGoCredentials, { onSaved: vi.fn() }))

    expect(screen.getByText('Checking…')).toBeTruthy()
    expect(screen.queryByText('Not saved')).toBeNull()
  })

  it('keeps status unconfirmed when the initial read fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        opencodeGoCredentials: {
          getStatus: vi.fn(async () => {
            throw new Error('status unavailable')
          }),
          saveApiKey: vi.fn(),
          clearApiKey: vi.fn()
        }
      }
    })

    render(createElement(OpenCodeGoCredentials, { onSaved: vi.fn() }))

    await screen.findByText('Status unavailable')
    expect(screen.queryByText('Not saved')).toBeNull()
    expect(consoleError).toHaveBeenCalledWith('Failed to load OpenCode Go credential status')
  })

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
