// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useAppStore } from '../../store'
import { TerminalInteractionSection } from './TerminalInteractionSection'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, defaultValue: string) => defaultValue,
  i18n: { language: 'en' }
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
})
