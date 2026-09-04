import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { emulatorPaneErrorMessage } from './emulator-pane-error-message'
import { markSimulatorDeviceBooted } from './emulator-device-state'
import { toSimulatorDeviceRows, type RawEmulatorDevice } from './emulator-device-row-mapping'
import type { SimulatorDeviceRow } from './emulator-pane-types'

export type EmulatorDeviceInventory = {
  devices: SimulatorDeviceRow[]
  setDevices: Dispatch<SetStateAction<SimulatorDeviceRow[]>>
  deviceRefreshErrorRef: RefObject<unknown>
  refreshDevices: (bootedTarget?: string | null) => Promise<SimulatorDeviceRow[]>
}

type UseEmulatorDeviceInventoryOptions = {
  mountedRef: RefObject<boolean>
  setError: Dispatch<SetStateAction<string | null>>
}

export function useEmulatorDeviceInventory({
  mountedRef,
  setError
}: UseEmulatorDeviceInventoryOptions): EmulatorDeviceInventory {
  const [devices, setDevices] = useState<SimulatorDeviceRow[]>([])
  const deviceRefreshErrorRef = useRef<unknown>(null)
  const refreshDevices = useCallback(
    async (bootedTarget?: string | null) => {
      try {
        // Unified list so Android devices/AVDs appear alongside iOS simulators.
        const raw = (await callRuntimeRpc(
          { kind: 'local' },
          'emulator.listDevices',
          {}
        )) as RawEmulatorDevice[]
        const list = toSimulatorDeviceRows(raw)
        const next = markSimulatorDeviceBooted(list, bootedTarget)
        if (!mountedRef.current) {
          return next
        }
        const hadRefreshError = deviceRefreshErrorRef.current !== null
        deviceRefreshErrorRef.current = null
        setDevices(next)
        if (hadRefreshError) {
          setError(null)
        }
        return next
      } catch (error) {
        deviceRefreshErrorRef.current = error
        if (mountedRef.current) {
          setDevices([])
          setError(emulatorPaneErrorMessage(error, 'Could not list emulator devices.'))
        }
        return []
      }
    },
    [mountedRef, setError]
  )

  return { devices, setDevices, deviceRefreshErrorRef, refreshDevices }
}
