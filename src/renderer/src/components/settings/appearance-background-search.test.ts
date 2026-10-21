import { describe, expect, it } from 'vitest'
import { buildInterfaceSettingsSections } from '@/hooks/settings-navigation-interface-sections'
import type { SettingsNavigationBuildOptions } from '@/hooks/settings-navigation-build-options'
import { getAppearancePaneSearchEntries } from './appearance-search'
import { matchesSettingsSearch } from './settings-search'

function appearanceNavEntries(isWebClient: boolean) {
  const options: SettingsNavigationBuildOptions = {
    isMac: true,
    isWindows: false,
    isLocalWindowsHost: false,
    isWindowsTerminalHost: false,
    isWebClient,
    nativeChatEnabled: false,
    hostQueuesMessages: false,
    managedBrowserCreationEnabled: false,
    mobileEmulatorCreationEnabled: false,
    isDev: false,
    isLinearConnected: false,
    repos: []
  }
  const appearance = buildInterfaceSettingsSections(options).find(
    (section) => section.id === 'appearance'
  )
  return appearance?.searchEntries ?? []
}

describe('app background search', () => {
  it.each(['background', 'wallpaper', 'image', 'blur', 'translucent'])(
    'finds the Background section for "%s" on desktop',
    (query) => {
      expect(
        matchesSettingsSearch(query, getAppearancePaneSearchEntries({ showAppBackground: true }))
      ).toBe(true)
    }
  )

  it('omits Background entries unless the caller opts in', () => {
    expect(getAppearancePaneSearchEntries().some((entry) => entry.title === 'Background')).toBe(
      false
    )
    expect(matchesSettingsSearch('wallpaper', getAppearancePaneSearchEntries())).toBe(false)
  })

  it('indexes Background in Settings navigation only for desktop clients', () => {
    expect(matchesSettingsSearch('wallpaper', appearanceNavEntries(false))).toBe(true)
    expect(matchesSettingsSearch('wallpaper', appearanceNavEntries(true))).toBe(false)
  })
})
