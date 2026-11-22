// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../../shared/settings/global-settings-test-fixture'
import { AppearanceFileExplorerSubsection } from './AppearanceFileExplorerSubsection'
import { getLayoutEntries } from './appearance-search'

describe('AppearanceFileExplorerSubsection', () => {
  afterEach(() => {
    cleanup()
  })

  it('defaults Reveal active file to on and toggles explorerRevealActiveFile', () => {
    const updateSettings = vi.fn()
    const defaultSettings = createGlobalSettingsFixture()
    const { rerender } = render(
      <AppearanceFileExplorerSubsection
        settings={defaultSettings}
        updateSettings={updateSettings}
        showGitIgnoredEntry={getLayoutEntries()[0]}
      />
    )

    expect(
      screen.getByText(
        'When the active editor file changes, select it in the file explorer and scroll it into view.'
      )
    ).toBeTruthy()

    const toggle = screen.getByRole('switch', { name: 'Reveal active file' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ explorerRevealActiveFile: false })

    rerender(
      <AppearanceFileExplorerSubsection
        settings={createGlobalSettingsFixture({ explorerRevealActiveFile: false })}
        updateSettings={updateSettings}
        showGitIgnoredEntry={getLayoutEntries()[0]}
      />
    )
    expect(
      screen.getByRole('switch', { name: 'Reveal active file' }).getAttribute('aria-checked')
    ).toBe('false')

    fireEvent.click(screen.getByRole('switch', { name: 'Reveal active file' }))
    expect(updateSettings).toHaveBeenLastCalledWith({ explorerRevealActiveFile: true })
  })
})
