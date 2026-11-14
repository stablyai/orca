import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { AutoRenameBranchFromWorkSetting } from './AutoRenameBranchFromWorkSetting'

const settings = { ...getDefaultSettings('/home/fixture'), uiLanguage: 'zh' as const }

function NamingSettingsPreview(): React.JSX.Element {
  const [value, setValue] = useState<GlobalSettings>({ ...settings, workspaceTitleLanguage: 'ui' })
  return (
    <AutoRenameBranchFromWorkSetting
      settings={value}
      updateSettings={(updates) => setValue((current) => ({ ...current, ...updates }))}
      writeSourceControlAiSettings={async () => {}}
      settingsSearchQuery=""
      forceVisible
    />
  )
}

export const followInterface = defineFixture({
  width: 720,
  store: { settings },
  render: () => <NamingSettingsPreview />
})

export const narrow = defineFixture({
  width: 360,
  store: { settings },
  render: () => <NamingSettingsPreview />
})

export const languages = defineFixture({
  width: 720,
  store: { settings },
  render: () => <NamingSettingsPreview />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[role="combobox"]')?.click()
  }
})
