import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useMobilePairingDevicePolling } from '../settings/mobile-pairing-device-polling'
import type { PairedDevice, StepIndex } from './MobileHero'
import {
  shouldShowPairedAfterDeviceRefresh,
  type MobilePageStage as FlowStage
} from './mobile-page-stage'
import {
  getPairedMobileDevicesSnapshot,
  replacePairedMobileDevices,
  usePairedMobileDevices
} from './paired-mobile-devices'
import { translate } from '@/i18n/i18n'

export function useMobilePagePairedDevices({
  stepIdx,
  setStepIdx
}: {
  stepIdx: StepIndex
  setStepIdx: Dispatch<SetStateAction<StepIndex>>
}): {
  devices: readonly PairedDevice[]
  stage: FlowStage | null
  revokingDeviceIds: readonly string[]
  enterFlow: () => void
  handleBack: () => void
  pairAnotherDevice: () => void
  revokeDevice: (deviceId: string) => Promise<void>
  showPairedDevices: (deviceCount: number) => void
} {
  // Wait for paired-device status before choosing a stage to avoid flashing the intro for returning users.
  const [stage, setStage] = useState<FlowStage | null>(null)
  const [revokingDeviceIds, setRevokingDeviceIds] = useState<string[]>([])
  const revokingDeviceIdsRef = useRef(new Set<string>())
  const [deviceCountAtPairStart, setDeviceCountAtPairStart] = useState<number | null>(null)
  const mountedRef = useMountedRef()
  const stageRef = useRef<FlowStage | null>(null)
  const deviceCountAtPairStartRef = useRef<number | null>(null)
  const { devices, refresh: refreshDevices } = usePairedMobileDevices({ refreshOnMount: false })

  const setPairingDeviceBaseline = useCallback(
    (count: number | null): void => {
      deviceCountAtPairStartRef.current = count
      if (mountedRef.current) {
        setDeviceCountAtPairStart(count)
      }
    },
    [mountedRef]
  )

  const showStage = useCallback(
    (nextStage: FlowStage | null): void => {
      stageRef.current = nextStage
      if (mountedRef.current) {
        setStage(nextStage)
      }
    },
    [mountedRef]
  )

  const showPairedDevices = useCallback(
    (deviceCount: number): void => {
      // Set the polling baseline with the transition so a render/effect gap cannot stop polling.
      setPairingDeviceBaseline(deviceCount)
      showStage('paired')
    },
    [setPairingDeviceBaseline, showStage]
  )

  const loadDevices = useCallback(
    async (
      opts: {
        force?: boolean
      } = {}
    ): Promise<readonly PairedDevice[]> => {
      try {
        const nextDevices = await refreshDevices(opts)
        if (mountedRef.current) {
          if (
            shouldShowPairedAfterDeviceRefresh({
              stage: stageRef.current,
              deviceCountAtPairStart: deviceCountAtPairStartRef.current,
              nextDeviceCount: nextDevices.length
            })
          ) {
            showPairedDevices(nextDevices.length)
          }
        }
        return nextDevices
      } catch (err) {
        console.error('mobile.listDevices failed', err)
        return []
      }
    },
    [mountedRef, refreshDevices, showPairedDevices]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const initialDevices = await loadDevices()
      if (cancelled) {
        return
      }
      if (initialDevices.length > 0) {
        showPairedDevices(initialDevices.length)
      } else {
        showStage('intro')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadDevices, showPairedDevices, showStage])

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      // Ref, not a state updater: React may defer the updater past this check.
      if (revokingDeviceIdsRef.current.has(deviceId)) {
        return
      }
      revokingDeviceIdsRef.current.add(deviceId)
      setRevokingDeviceIds((prev) => [...prev, deviceId])
      try {
        const { revoked } = await window.api.mobile.revokeDevice({ deviceId })
        // revoked=false is failure; do not refresh, announce success or route away.
        if (!revoked) {
          throw new Error('mobile.revokeDevice returned revoked=false')
        }
        // Once revoked, reload failure must still report success; remove from last-known devices rather than treating failed loading as an empty list.
        let remaining: readonly PairedDevice[]
        try {
          remaining = await refreshDevices({ force: true })
        } catch (err) {
          console.error('mobile.listDevices failed after revoke', err)
          remaining = getPairedMobileDevicesSnapshot().filter((d) => d.deviceId !== deviceId)
          replacePairedMobileDevices(remaining)
        }
        if (mountedRef.current) {
          toast.success(translate('auto.components.mobile.MobilePage.255372e6e8', 'Device revoked'))
        }
        if (remaining.length === 0 && mountedRef.current) {
          showStage('intro')
        }
      } catch {
        if (mountedRef.current) {
          toast.error(
            translate('auto.components.mobile.MobilePage.4e1eb5d55c', 'Failed to revoke device')
          )
        }
      } finally {
        revokingDeviceIdsRef.current.delete(deviceId)
        if (mountedRef.current) {
          setRevokingDeviceIds((prev) => prev.filter((id) => id !== deviceId))
        }
      }
    },
    [mountedRef, refreshDevices, showStage]
  )

  const polledLoadDevices = useCallback(async () => {
    await loadDevices()
  }, [loadDevices])

  // Watch for completed pairings both while waiting for a QR scan and on the paired-device summary.
  useMobilePairingDevicePolling({
    deviceCountAtQr:
      (stage === 'flow' && stepIdx === 1) || stage === 'paired' ? deviceCountAtPairStart : null,
    currentDeviceCount: devices.length,
    loadDevices: polledLoadDevices
  })

  const enterFlow = (): void => {
    setStepIdx(0)
    setPairingDeviceBaseline(devices.length)
    showStage('flow')
  }

  const pairAnotherDevice = (): void => {
    setStepIdx(1)
    setPairingDeviceBaseline(devices.length)
    showStage('flow')
  }

  const handleBack = (): void => {
    if (stepIdx === 1) {
      setStepIdx(0)
    } else if (devices.length > 0) {
      // Back from pairing another device returns to the existing paired summary.
      showPairedDevices(devices.length)
    } else {
      showStage('intro')
    }
  }

  return {
    devices,
    stage,
    revokingDeviceIds,
    enterFlow,
    handleBack,
    pairAnotherDevice,
    revokeDevice,
    showPairedDevices
  }
}
