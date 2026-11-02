import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { EmulatorOpeningSettings } from './EmulatorOpeningSettings'
const devices = [
  { name: 'Pixel9_API36', udid: 'Pixel9_API36', runtime: 'Android' },
  { name: 'iPhone 18 Pro', udid: 'iphone', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2' }
]
export const lastUsed = defineFixture({
  store: { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' } },
  width: 680,
  render: () => (
    <div className="p-4">
      <EmulatorOpeningSettings
        settings={getDefaultSettings('/tmp')}
        devices={devices}
        enabled
        updateSettings={async () => {}}
      />
    </div>
  )
})
export const fixedDevice = defineFixture({
  store: { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' } },
  width: 680,
  render: () => (
    <div className="p-4">
      <EmulatorOpeningSettings
        settings={{
          ...getDefaultSettings('/tmp'),
          mobileEmulatorDefaultDeviceUdid: 'Pixel9_API36'
        }}
        devices={devices}
        enabled
        updateSettings={async () => {}}
      />
    </div>
  )
})
