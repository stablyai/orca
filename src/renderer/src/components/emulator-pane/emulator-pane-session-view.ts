import { SIMULATOR_DEFAULT_TAB_LABEL } from '@/lib/simulator-tab-label'
import {
  simulatorPreviewStreamUrl,
  type EmulatorPaneSession,
  type SimulatorDeviceRow
} from './emulator-pane-types'

type BuildEmulatorPaneSessionViewArgs = {
  devices: SimulatorDeviceRow[]
  selectedUdid: string | null
  session: EmulatorPaneSession | null
}

export function buildEmulatorPaneSessionView({
  devices,
  selectedUdid,
  session
}: BuildEmulatorPaneSessionViewArgs) {
  const selectedDevice = devices.find((device) => device.udid === selectedUdid) ?? null
  const sessionDisplayName = session?.info?.displayName
  const hasSpecificSessionDisplayName =
    sessionDisplayName &&
    sessionDisplayName !== 'Simulator' &&
    sessionDisplayName !== SIMULATOR_DEFAULT_TAB_LABEL
  const previewUrl = simulatorPreviewStreamUrl(session?.info)
  return {
    displayName: hasSpecificSessionDisplayName
      ? sessionDisplayName
      : selectedDevice?.name || sessionDisplayName || SIMULATOR_DEFAULT_TAB_LABEL,
    previewUrl,
    wsUrl: session?.info?.wsUrl,
    isLive: Boolean(previewUrl && session?.attached),
    selectedDevice
  }
}
