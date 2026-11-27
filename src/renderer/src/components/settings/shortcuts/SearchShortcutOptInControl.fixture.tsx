import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getLegacySearchBindings } from '../../../../../shared/keybindings/definitions'
import { getLegacyProfileSearchDefaults } from '../../../../../shared/keybindings/search-shortcut-opt-in'
import type {
  KeybindingFileSnapshot,
  SearchShortcutChoiceResult,
  KeybindingPlatform,
  SearchShortcutChoice
} from '../../../../../shared/keybindings/types'
import { useAppStore } from '@/store'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchShortcutOptInControl } from './SearchShortcutOptInControl'

function legacyProfile(
  platform: KeybindingPlatform,
  choice: SearchShortcutChoice | null
): KeybindingFileSnapshot {
  const defaults = choice
    ? getLegacyProfileSearchDefaults(platform, choice)
    : getLegacySearchBindings(platform)
  return {
    path: '/preview/keybindings.json',
    platform,
    exists: false,
    overrides: defaults,
    defaultOverrides: defaults,
    commonOverrides: {},
    platformOverrides: {},
    diagnostics: [],
    searchShortcut: { choice }
  }
}

function row(platform: KeybindingPlatform, choice: SearchShortcutChoice | null) {
  return defineFixture({
    width: 640,
    render: () => (
      <SettingsGroup>
        <SearchShortcutOptInControl snapshot={legacyProfile(platform, choice)} />
      </SettingsGroup>
    )
  })
}

export const macUndecided = row('darwin', null)
export const macSwitched = row('darwin', 'accepted')
export const windowsUndecided = row('win32', null)
export const windowsSwitched = row('win32', 'accepted')

// A save that may not have landed: the row says so and offers to save again.
export const macUnconfirmed = defineFixture({
  width: 640,
  setup: () =>
    useAppStore.setState({
      setSearchShortcutChoice: async (): Promise<SearchShortcutChoiceResult['outcome']> =>
        'unconfirmed'
    }),
  render: () => (
    <SettingsGroup>
      <SearchShortcutOptInControl snapshot={legacyProfile('darwin', null)} />
    </SettingsGroup>
  ),
  interact: async (frame) => {
    const radios = frame.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    radios[1]?.click()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  }
})
