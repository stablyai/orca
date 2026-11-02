import { getDefaultSettings } from '../../../../shared/constants'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { EmulatorDevicePicker } from './emulator-device-picker'
import type { SimulatorDeviceRow } from './emulator-pane-types'
const devices: SimulatorDeviceRow[] = [
  {
    name: 'Pixel9_API36',
    udid: 'emulator-5554',
    backend: 'android',
    osVersion: '16',
    apiLevel: '36',
    state: 'Booted'
  },
  {
    name: 'iPhone 18 Pro',
    udid: '0F203250-F945-4DD1-A8C8-8F362FAE83E6',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
    lastUsedAt: '2026-10-31',
    state: 'Shutdown'
  },
  {
    name: 'iPhone 18 Pro',
    udid: '77CEFE03-CCA4-4647-84DC-FCDEAFD1589E',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
    state: 'Shutdown'
  },
  {
    name: 'iPhone 17 Pro Max with a very long personal device name',
    udid: 'other',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
    state: 'Shutdown',
    isAvailable: false,
    availabilityError: 'The iOS 27.0 simulator runtime is not installed.'
  }
]
export const usedDevices = defineFixture({
  store: { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' } },
  width: 400,
  render: () => (
    <div className="p-4">
      <EmulatorDevicePicker
        devices={devices}
        selectedUdid="emulator-5554"
        onSelectDevice={() => {}}
      />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[role=combobox]')?.click()
  }
})
export const allDevices = defineFixture({
  store: { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' } },
  width: 400,
  render: () => (
    <div className="p-4">
      <EmulatorDevicePicker
        devices={devices}
        selectedUdid="emulator-5554"
        onSelectDevice={() => {}}
      />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[role=combobox]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLElement>('[cmdk-item][data-value=other-devices]')?.click()
    document.querySelector<HTMLElement>('[cmdk-item][data-value=unavailable-devices]')?.click()
  }
})
