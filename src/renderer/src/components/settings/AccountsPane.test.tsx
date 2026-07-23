import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
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

describe('AccountsPane', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useAppStore.setState({ settingsSearchQuery: '' })
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
    const originalOwnUserAgent = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent')
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
})
