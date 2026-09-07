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
  // Why: stage starts unresolved so we don't flash the intro before we know
  // whether any devices are already paired.
  const [stage, setStage] = useState<FlowStage | null>(null)
  const [revokingDeviceIds, setRevokingDeviceIds] = useState<string[]>([])
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
      // Why: paired-view polling uses this baseline; setting it with the
      // transition avoids the render-plus-Effect gap where polling stops.
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
        // Log so a transient IPC failure (which routes the user to 'intro') is
        // observable; keep returning [] so callers' behavior is unchanged.
        console.error('mobile.listDevices failed', err)
        return []
      }
    },
    [mountedRef, refreshDevices, showPairedDevices]
  )

  // Why: pick the initial stage based on whether any devices are already
  // paired so returning users don't see the marketing intro every time.
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
      // Dedupe rapid double-clicks: if a revoke for this id is already in
      // flight, bail before issuing a second IPC call.
      let alreadyRevoking = false
      setRevokingDeviceIds((prev) => {
        if (prev.includes(deviceId)) {
          alreadyRevoking = true
          return prev
        }
        return [...prev, deviceId]
      })
      if (alreadyRevoking) {
        return
      }
      try {
        const { revoked } = await window.api.mobile.revokeDevice({ deviceId })
        // Why: the backend can resolve revoked=false without removing anything;
        // treat it as a failure BEFORE refreshing or routing, so a revoke that
        // didn't happen can't flash a success toast or drop the user to intro.
        if (!revoked) {
          throw new Error('mobile.revokeDevice returned revoked=false')
        }
        // Why: revoke already succeeded server-side, so a failed post-revoke
        // reload must not flash "Failed to revoke". Optimistically drop the
        // revoked device from the last-known list (not loadDevices' bogus [] from
        // a failed reload), keeping success + intro-routing correct. Mirrors
        // MobilePane's revoke fallback.
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

  // Why: poll for new pairings on Step 2 (waiting for the first pair) and
  // also on the paired view (so additional phones that finish pairing while
  // the user is reading the list show up without a manual refresh).
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
      // Why: "Pair another device" can start from the paired summary; Back on
      // step 0 should return there rather than the intro while devices exist.
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
