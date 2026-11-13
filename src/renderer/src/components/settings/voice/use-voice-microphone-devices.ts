import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listVoiceMicrophoneDevices,
  type VoiceMicrophoneDevice
} from '@/components/dictation/microphone-devices'
import { useMountedRef } from '@/hooks/useMountedRef'

function sameDeviceList(
  a: readonly VoiceMicrophoneDevice[],
  b: readonly VoiceMicrophoneDevice[]
): boolean {
  return (
    a.length === b.length &&
    a.every((device, index) => {
      const other = b[index]
      return device.deviceId === other?.deviceId && device.label === other.label
    })
  )
}

/** The live microphone list, rescanned on devicechange and whenever `rescanKey` changes. */
export function useVoiceMicrophoneDevices(rescanKey: unknown): {
  devices: VoiceMicrophoneDevice[]
  devicesKnown: boolean
  refreshDevices: () => Promise<void>
} {
  const [devices, setDevices] = useState<VoiceMicrophoneDevice[]>([])
  const [devicesKnown, setDevicesKnown] = useState(false)
  const mountedRef = useMountedRef()
  // Bluetooth emits repeated devicechange events; reject stale enumeration results.
  const refreshGenerationRef = useRef(0)

  const refreshDevices = useCallback(async (): Promise<void> => {
    const generation = refreshGenerationRef.current + 1
    refreshGenerationRef.current = generation
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return
    }
    let next: VoiceMicrophoneDevice[] = []
    try {
      next = listVoiceMicrophoneDevices(await navigator.mediaDevices.enumerateDevices())
    } catch {
      next = []
    }
    if (!mountedRef.current || refreshGenerationRef.current !== generation) {
      return
    }
    setDevicesKnown(next.length > 0)
    setDevices((current) => (sameDeviceList(current, next) ? current : next))
  }, [mountedRef])

  useEffect(() => {
    void refreshDevices()
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) {
      return
    }
    const handleDeviceChange = (): void => {
      void refreshDevices()
    }
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [refreshDevices, rescanKey])

  return { devices, devicesKnown, refreshDevices }
}
