// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useAppStore } from '../../store'
import { TerminalInteractionSection } from './TerminalInteractionSection'

const i18nMock = vi.hoisted(() => ({
  language: 'en',
  translations: {} as Record<string, string>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, defaultValue: string) => i18nMock.translations[key] ?? defaultValue,
  i18n: i18nMock
}))

vi.mock('@/i18n/localized-catalog', () => ({
  createLocalizedCatalog: (factory: () => unknown) => factory
}))

describe('TerminalInteractionSection scroll on input', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsSearchQuery: '' })
  })

  afterEach(() => {
    cleanup()
    i18nMock.language = 'en'
    i18nMock.translations = {}
  })

  it('turns off jump-to-bottom on input from the settings switch', () => {
    const updateSettings = vi.fn()
    render(
      <TerminalInteractionSection
        settings={createGlobalSettingsFixture()}
        updateSettings={updateSettings}
        searchQuery=""
      />
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Scroll to Bottom on Input' }))

    expect(updateSettings).toHaveBeenCalledWith({ terminalScrollOnUserInput: false })
  })

  it('turns jump-to-bottom back on when the setting is off', () => {
    const updateSettings = vi.fn()
    render(
      <TerminalInteractionSection
        settings={createGlobalSettingsFixture({ terminalScrollOnUserInput: false })}
        updateSettings={updateSettings}
        searchQuery=""
      />
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Scroll to Bottom on Input' }))

    expect(updateSettings).toHaveBeenCalledWith({ terminalScrollOnUserInput: true })
  })

  it('keeps the row visible for a localized search keyword', () => {
    i18nMock.language = 'de'
    i18nMock.translations = { 'components.settings.terminal.search.snap': 'einrasten' }
    useAppStore.setState({ settingsSearchQuery: 'einrasten' })

    render(
      <TerminalInteractionSection
        settings={createGlobalSettingsFixture()}
        updateSettings={vi.fn()}
        searchQuery="einrasten"
      />
    )

    expect(screen.getByRole('switch', { name: 'Scroll to Bottom on Input' })).toBeTruthy()
  })
})
