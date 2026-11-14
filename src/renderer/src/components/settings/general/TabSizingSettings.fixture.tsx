import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { TabSizingSettings as TabSizingSettingsValue } from '../../../../../shared/tab-sizing'
import { TabSizingSettings } from './TabSizingSettings'

function TabSizingSettingsFixture(initial: TabSizingSettingsValue): React.JSX.Element {
  const [settings, setSettings] = useState(initial)
  return (
    <TabSizingSettings
      settings={settings}
      updateSettings={(updates) => setSettings((current) => ({ ...current, ...updates }))}
    />
  )
}

export const auto = defineFixture({
  width: 760,
  render: () => <TabSizingSettingsFixture tabSizing="auto" />
})

export const fit = defineFixture({
  width: 760,
  render: () => <TabSizingSettingsFixture tabSizing="fit" tabSizingMinWidth={100} />
})
