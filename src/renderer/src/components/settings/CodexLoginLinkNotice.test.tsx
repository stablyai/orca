// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../i18n/i18n'
import { CodexLoginLinkNotice } from './CodexLoginLinkNotice'

const AUTH_URL = 'https://auth.openai.com/oauth/authorize?client_id=orca&state=abc123'

type LinkListener = (url: string | null) => void

function stubApi(pendingUrl: string | null): {
  listeners: LinkListener[]
  writeClipboardText: ReturnType<typeof vi.fn>
  openUrl: ReturnType<typeof vi.fn>
} {
  const listeners: LinkListener[] = []
  const writeClipboardText = vi.fn(() => Promise.resolve())
  const openUrl = vi.fn(() => Promise.resolve())
  Object.defineProperty(globalThis, 'api', {
    configurable: true,
    value: {
      codexAccounts: {
        getPendingLoginUrl: () => Promise.resolve(pendingUrl),
        onPendingLoginUrlChanged: (listener: LinkListener) => {
          listeners.push(listener)
          return () => {
            listeners.splice(listeners.indexOf(listener), 1)
          }
        }
      },
      ui: { writeClipboardText },
      shell: { openUrl }
    }
  })
  return { listeners, writeClipboardText, openUrl }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(globalThis, 'api')
})

describe('CodexLoginLinkNotice', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders nothing while no login is waiting on a browser', async () => {
    stubApi(null)
    const { container } = render(<CodexLoginLinkNotice />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('shows the link of a login that was already running when Settings opened', async () => {
    stubApi(AUTH_URL)
    const { container } = render(<CodexLoginLinkNotice />)
    await waitFor(() => expect(container.textContent).toContain(AUTH_URL))
  })

  it('copies the link and opens it in the default browser on request', async () => {
    const { listeners, writeClipboardText, openUrl } = stubApi(null)
    const { container } = render(<CodexLoginLinkNotice />)
    await waitFor(() => expect(listeners.length).toBe(1))

    listeners[0](AUTH_URL)
    await waitFor(() => expect(container.textContent).toContain('Copy link'))

    const button = (label: string): HTMLButtonElement => {
      const found = Array.from(container.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes(label)
      )
      expect(found).not.toBeUndefined()
      return found!
    }

    fireEvent.click(button('Copy link'))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(AUTH_URL))
    await waitFor(() => expect(container.textContent).toContain('Copied'))

    fireEvent.click(button('Open'))
    expect(openUrl).toHaveBeenCalledWith(AUTH_URL)
  })

  it('drops the link once the login ends', async () => {
    const { listeners } = stubApi(AUTH_URL)
    const { container } = render(<CodexLoginLinkNotice />)
    await waitFor(() => expect(container.textContent).toContain(AUTH_URL))

    listeners[0](null)
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})
