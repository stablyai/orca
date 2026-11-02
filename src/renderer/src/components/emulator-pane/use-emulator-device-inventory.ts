import {
  useCallback,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction
} from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toSimulatorDeviceRows, type RawEmulatorDevice } from './emulator-device-row-mapping'
import { markSimulatorDeviceBooted } from './emulator-device-state'
import { emulatorListDevicesErrorText } from './emulator-pane-error-copy'
import type { SimulatorDeviceRow } from './emulator-pane-types'

export function useEmulatorDeviceInventory(
  mountedRef: RefObject<boolean>,
  setError: Dispatch<SetStateAction<string | null>>
) {
  const [devices, setDevices] = useState<SimulatorDeviceRow[]>([])
  const deviceRefreshErrorRef = useRef<unknown>(null)
  const refreshDevices = useCallback(
    async (bootedTarget?: string | null) => {
      try {
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
          setError(emulatorListDevicesErrorText(error))
        }
        return []
      }
    },
    [mountedRef, setError]
  )

  const markDeviceBooted = useCallback(
    (rows: SimulatorDeviceRow[], target?: string | null) => {
      const next = markSimulatorDeviceBooted(rows, target)
      if (mountedRef.current && next !== rows) {
        setDevices(next)
      }
      return next
    },
    [mountedRef]
  )
  return { devices, setDevices, refreshDevices, deviceRefreshErrorRef, markDeviceBooted }
}
