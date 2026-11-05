import type React from 'react'
import { useAppStore } from '../../../store/index'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import {
  getAutoDownloadUpdatesDescription,
  getAutoDownloadUpdatesTitle
} from './auto-download-updates-copy'

export function AutoDownloadUpdatesSetting(): React.JSX.Element {
  const enabled = useAppStore((s) => s.settings?.autoDownloadUpdates === true)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const title = getAutoDownloadUpdatesTitle()
  const description = getAutoDownloadUpdatesDescription()

  const toggle = (): void => {
    const next = !enabled
    void updateSettings({ autoDownloadUpdates: next }).then(() => {
      const status = useAppStore.getState().updateStatus
      // An offer already on screen would otherwise wait for the next scheduled check.
      if (next && status.state === 'available' && !status.externallyManaged) {
        void window.api.updater.download()
      }
    })
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['update', 'download', 'automatic', 'background', 'install']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={enabled}
        onChange={toggle}
      />
    </SearchableSetting>
  )
}
