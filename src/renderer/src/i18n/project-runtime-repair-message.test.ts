import { expect, it } from 'vitest'
import en from './locales/en.json'
import {
  agentLaunchRepairRefusal,
  projectRuntimeRepairSentence
} from '../../../shared/project-runtime-repair-message'

const page = new Map(Object.entries(en.auto.components.settings.ProjectWindowsRuntimeSetting))
const preferredRuntime = { kind: 'wsl', distro: 'Ubuntu' } as const
const base = {
  projectId: 'p',
  preferredRuntime,
  source: 'project-override',
  cacheKey: 'k'
} as const

// The window shows the catalog's English and the host writes the module's, so they must not drift.
it("words each repair under the settings page's key, in the window's English", () => {
  const reasons = ['wsl-unavailable', 'wsl-distro-missing', 'wsl-distro-required'] as const
  const names = reasons.map((reason) =>
    projectRuntimeRepairSentence({ ...base, reason }, (key, english) => {
      const name = key.replace('auto.components.settings.ProjectWindowsRuntimeSetting.', '')
      expect(page.get(name)).toBe(english)
      return name
    })
  )
  expect(names).toEqual(['wslUnavailable', 'distroMissing', 'distroRequired'])
  const byDefault = { ...base, reason: 'wsl-unavailable', source: 'global-default' } as const
  expect(agentLaunchRepairRefusal(byDefault)).toMatch(
    /the default in Settings > Project Runtime\.$/
  )
})
