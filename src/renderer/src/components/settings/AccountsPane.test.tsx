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

function extractSection(markup: string, sectionId: string): string {
  const start = markup.indexOf(`id="${sectionId}"`)
  if (start < 0) {
    return ''
  }
  const nextSection = markup.indexOf('<section', start + 1)
  return markup.slice(start, nextSection < 0 ? undefined : nextSection)
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

  it('keeps the runtime label inside the localized account copy', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('Showing accounts for This device. New accounts are added there.')
    expect(markup).toContain('authenticate with Google for This device. This uses credentials')
    expect(markup).not.toContain('ShowingThis device')
    expect(markup).not.toContain('forThis device')
  })

  it('localizes the runtime label before interpolating account copy', async () => {
    await i18n.changeLanguage('es')

    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain(
      'Mostrando cuentas para este dispositivo. Las nuevas cuentas se agregan allí.'
    )
    expect(markup).not.toContain('This device')
  })

  it('renders the Z.AI API-key section with save and clear affordances', () => {
    useAppStore.setState({ settingsSearchQuery: 'zai' })

    const markup = renderPane(getDefaultSettings('/tmp'))
    const zaiSection = extractSection(markup, 'accounts-zai')

    expect(zaiSection).toContain('API Key')
    expect(zaiSection).toContain('https://api.z.ai/api/anthropic')
    expect(zaiSection).toContain('Save')
    expect(zaiSection).toContain('Clear')
  })

  it('does not interpolate WSL runtime copy into the Z.AI section', () => {
    useAppStore.setState({ settingsSearchQuery: 'zai' })

    const markup = renderPane(getDefaultSettings('/tmp'))
    const zaiSection = extractSection(markup, 'accounts-zai')

    expect(zaiSection).not.toContain(
      'Showing accounts for This device. New accounts are added there.'
    )
    expect(zaiSection).not.toContain('Use your current This device')
  })

  it('shows the Z.AI section when searching for zai', () => {
    useAppStore.setState({ settingsSearchQuery: 'zai' })

    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('id="accounts-zai"')
    expect(markup).toContain('placeholder="sk-..."')
  })
})
