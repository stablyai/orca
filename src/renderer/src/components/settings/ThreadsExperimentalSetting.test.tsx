// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { normalizeLoadedGlobalSettings } from '../../../../main/persistence/loading-store/normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from '../../../../main/persistence/loading-store/prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from '../../../../main/persistence/loading-store/prepare-loaded-profile-settings'
import { ThreadsExperimentalSetting } from './ThreadsExperimentalSetting'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: { settingsSearchQuery: string }) => unknown) =>
    select({ settingsSearchQuery: '' })
}))
afterEach(cleanup)

it.each([undefined, true, false])(
  'loads an existing profile with Threads=%s through to the real setting and toggle',
  (saved) => {
    const defaults = getDefaultPersistedState('/tmp/pr-36661-profile')
    const parsed = structuredClone(defaults)
    if (saved === undefined) {
      delete parsed.settings.experimentalThreads
    } else {
      parsed.settings.experimentalThreads = saved
    }
    const notify = () => {}
    const migrated = normalizeLoadedGlobalSettings(
      parsed,
      prepareLoadedTerminalSettings(parsed, notify),
      prepareLoadedProfileSettings(parsed, defaults, notify)
    )
    expect(migrated.experimentalThreads).toBe(saved ?? false)
    const update = vi.fn()
    function Setting() {
      const [settings, setSettings] = useState(migrated)
      return (
        <ThreadsExperimentalSetting
          settings={settings}
          updateSettings={(patch) => {
            update(patch)
            setSettings({ ...settings, ...patch })
          }}
        />
      )
    }
    render(<Setting />)
    expect(screen.getByText('Start a chat in a project without creating a workspace.')).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: 'Threads' })
    expect(toggle.getAttribute('aria-checked')).toBe(String(saved ?? false))
    fireEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ experimentalThreads: !(saved ?? false) })
    expect(toggle.getAttribute('aria-checked')).toBe(String(!(saved ?? false)))
  }
)
