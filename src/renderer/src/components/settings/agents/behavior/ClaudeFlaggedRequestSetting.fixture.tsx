import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { useAppStore } from '../../../../store'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { LOCAL_SETTINGS_HOST_SCOPE } from '../../host-scope/settings-host-scope'
import { ClaudeFlaggedRequestSetting } from './ClaudeFlaggedRequestSetting'

function FlaggedRequestFixture(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    return null
  }
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <SettingsGroup>
        <ClaudeFlaggedRequestSetting
          settings={settings}
          updateSettings={updateSettings}
          hostScope={LOCAL_SETTINGS_HOST_SCOPE}
        />
      </SettingsGroup>
    </div>
  )
}

export const switchModel = defineFixture({ width: 720, render: () => <FlaggedRequestFixture /> })

export const stop = defineFixture({
  ...switchModel,
  store: { settings: { ...getDefaultSettings('/fixture'), claudeFlaggedRequestAction: 'stop' } }
})

export const choices = defineFixture({
  ...switchModel,
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLElement>('[role="combobox"]')
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
    for (let wait = 0; wait < 50 && !document.querySelector('[role="listbox"]'); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
})
