import { useCallback, useEffect, useRef, useState } from 'react'
import type { AndroidSetupStatus, IosSetupStatus } from '../../../../shared/emulator-setup-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export type SimulatorDeviceRow = {
  name: string
  udid: string
  state: string
  runtime?: string
  isAvailable?: boolean
}

export type EmulatorAvailability = {
  platform: string
  available: boolean
  devices: SimulatorDeviceRow[]
  ios: IosSetupStatus
  simctl: { ok: boolean; message?: string }
  serveSim: { ok: boolean; message?: string }
  android: AndroidSetupStatus & { sdkFound?: boolean }
  message: string
}

function failedAvailability(error: unknown): EmulatorAvailability {
  return {
    platform: '',
    available: false,
    devices: [],
    ios: {
      state: 'error',
      message: 'Could not check iOS Simulator setup.',
      installedXcodes: [],
      devices: []
    },
    simctl: { ok: false },
    serveSim: { ok: false },
    android: {
      state: 'error',
      message: 'Could not check Android Emulator setup.',
      configuredPath: false,
      studioInstalled: false,
      components: { platformTools: false, emulator: false, systemImages: false }
    },
    message: error instanceof Error ? error.message : 'Could not check emulator availability.'
  }
}

export function useMobileEmulatorAvailability(): {
  availability: EmulatorAvailability | null
  refreshing: boolean
  refreshAvailability: () => Promise<void>
} {
  const [availability, setAvailability] = useState<EmulatorAvailability | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const refreshSequence = useRef(0)
  const refreshAvailability = useCallback(async (): Promise<void> => {
    const sequence = ++refreshSequence.current
    setRefreshing(true)
    try {
      const result = await callRuntimeRpc<EmulatorAvailability>(
        { kind: 'local' },
        'emulator.availability',
        {}
      )
      if (sequence === refreshSequence.current) {
        setAvailability(result)
      }
    } catch (error) {
      if (sequence === refreshSequence.current) {
        setAvailability(failedAvailability(error))
      }
    } finally {
      if (sequence === refreshSequence.current) {
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void refreshAvailability()
    const refreshOnReturn = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshAvailability()
      }
    }
    window.addEventListener('focus', refreshOnReturn)
    return () => {
      window.removeEventListener('focus', refreshOnReturn)
    }
  }, [refreshAvailability])

  return { availability, refreshing, refreshAvailability }
}
