// @vitest-environment happy-dom

import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CodexRateLimitAccountsState, GlobalSettings } from '../../../../shared/types'
import { i18n } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { AccountsPane } from './AccountsPane'

function renderPane(
  settings: GlobalSettings,
  props: Partial<React.ComponentProps<typeof AccountsPane>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(AccountsPane, {
      settings,
      updateSettings: vi.fn(),
      ...props
    })
  )
}

let interactiveContainer: HTMLDivElement | null = null
let interactiveRoot: Root | null = null

async function renderInteractivePane(settings: GlobalSettings): Promise<HTMLDivElement> {
  interactiveContainer = document.createElement('div')
  document.body.appendChild(interactiveContainer)
  interactiveRoot = createRoot(interactiveContainer)

  await act(async () => {
    interactiveRoot?.render(
      React.createElement(AccountsPane, {
        settings,
        updateSettings: vi.fn()
      })
    )
  })
  await act(async () => {
    await Promise.resolve()
  })

  return interactiveContainer
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function installAccountsApi(
  codexAccounts: CodexRateLimitAccountsState,
  reauthenticate: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>,
  cancelReauthentication: (args: { accountId: string }) => Promise<boolean>
): void {
  Object.assign(window, {
    api: {
      codexAccounts: {
        list: vi.fn().mockResolvedValue(codexAccounts),
        add: vi.fn().mockResolvedValue(codexAccounts),
        reauthenticate,
        cancelReauthentication,
        remove: vi.fn().mockResolvedValue(codexAccounts),
        select: vi.fn().mockResolvedValue(codexAccounts)
      },
      claudeAccounts: {
        list: vi.fn().mockResolvedValue({
          accounts: [],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: {} }
        }),
        add: vi.fn(),
        reauthenticate: vi.fn(),
        remove: vi.fn(),
        select: vi.fn()
      }
    }
  })
}

describe('AccountsPane', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
    useAppStore.setState({ settingsSearchQuery: '' })
  })

  afterEach(() => {
    act(() => {
      interactiveRoot?.unmount()
    })
    interactiveContainer?.remove()
    interactiveRoot = null
    interactiveContainer = null
  })

  it('hides the WSL account location controls on platforms without WSL support', () => {
    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      localAccountRuntime: 'wsl'
    })

    expect(markup).not.toContain('Account location')
    expect(markup).not.toContain('aria-label="Account location"')
    expect(markup).not.toContain('WSL is not available on this machine.')
  })

  it('keeps the WSL account location controls on Windows-class hosts', () => {
    const markup = renderPane(
      {
        ...getDefaultSettings('/tmp'),
        localAccountRuntime: 'wsl'
      },
      { wslSupportedPlatform: true, wslCapabilitiesLoading: true }
    )

    expect(markup).toContain('Account location')
    expect(markup).toContain('aria-label="Account location"')
    expect(markup).toContain('role="radio" aria-checked="true" disabled=""')
  })

  it('selects the WSL account location under auto when the global project runtime is WSL', () => {
    // Why: navigator.userAgent is a read-only prototype getter, so shadow it with
    // a configurable own property and remove that shadow afterward to restore it.
    const originalOwnUserAgent = Object.getOwnPropertyDescriptor(
      globalThis.navigator,
      'userAgent'
    )
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true
    })
    try {
      const markup = renderPane(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'auto',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        },
        { wslSupportedPlatform: true, wslCapabilitiesLoading: true }
      )

      expect(markup).toContain('aria-label="Account location"')
      // The resolved WSL radio is the checked option (disabled while capabilities load).
      expect(markup).toContain('role="radio" aria-checked="true" disabled=""')
    } finally {
      if (originalOwnUserAgent) {
        Object.defineProperty(globalThis.navigator, 'userAgent', originalOwnUserAgent)
      } else {
        delete (globalThis.navigator as { userAgent?: string }).userAgent
      }
    }
  })

  it('keeps the runtime label inside the localized account copy', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('Showing accounts for this device. New accounts are added there.')
    expect(markup).toContain('authenticate with Google for this device. This uses credentials')
    expect(markup).not.toContain('ShowingThis device')
    expect(markup).not.toContain('forThis device')
  })

  it('localizes the runtime label before interpolating account copy', async () => {
    await i18n.changeLanguage('es')

    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toMatch(
      /Mostrando cuentas para [Ee]ste dispositivo\. Las nuevas cuentas se agregan allí\./
    )
    expect(markup).not.toContain('This device')
  })

  it('scopes account copy to the active remote server and disables local sign-in actions', () => {
    // Note: static SSR markup reads the store's initial state (zustand v5), so
    // this exercises the fallback server label; the named-server path is
    // covered by live validation against a paired server.
    const markup = renderPane(
      {
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'env-1'
      },
      { wslSupportedPlatform: true }
    )

    expect(markup).toContain(
      'Showing accounts managed by the remote server. Add or re-authenticate accounts on that server.'
    )
    // The WSL account-location toggle is a local concern; a remote owner hides it.
    expect(markup).not.toContain('aria-label="Account location"')
    const addAccountIndex = markup.indexOf('Add Account')
    expect(addAccountIndex).toBeGreaterThan(0)
    expect(markup.slice(markup.lastIndexOf('<button', addAccountIndex), addAccountIndex)).toContain(
      'disabled=""'
    )
  })

  it('keeps local copy and enabled sign-in actions when no remote server is active', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('Showing accounts for this device. New accounts are added there.')
    const addAccountIndex = markup.indexOf('Add Account')
    expect(addAccountIndex).toBeGreaterThan(0)
    expect(
      markup.slice(markup.lastIndexOf('<button', addAccountIndex), addAccountIndex)
    ).not.toContain('disabled=""')
  })

  it('lets a pending Codex re-authentication be cancelled', async () => {
    const codexAccounts: CodexRateLimitAccountsState = {
      accounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomeRuntime: 'host',
          wslDistro: null,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'two@example.com',
          managedHomeRuntime: 'host',
          wslDistro: null,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeAccountId: 'account-1',
      activeAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    }
    const reauthenticate = vi.fn(() => new Promise<CodexRateLimitAccountsState>(() => undefined))
    const cancelReauthentication = vi.fn().mockResolvedValue(true)
    installAccountsApi(codexAccounts, reauthenticate, cancelReauthentication)

    const container = await renderInteractivePane(getDefaultSettings('/tmp'))
    expect(container.textContent).toContain('one@example.com')

    await act(async () => {
      findButton(container, 'Re-authenticate').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    expect(reauthenticate).toHaveBeenCalledWith({ accountId: 'account-1' })
    await act(async () => {
      findButton(container, 'Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(cancelReauthentication).toHaveBeenCalledWith({ accountId: 'account-1' })
  })
})
