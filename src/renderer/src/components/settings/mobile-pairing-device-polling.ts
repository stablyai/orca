import { useEffect } from 'react'

export const MOBILE_PAIRING_DEVICE_POLL_MS = 3000

export type MobilePairingDevicePollState = {
  deviceCountAtQr: number | null
  currentDeviceCount: number
  visibilityState: Document['visibilityState']
  focused: boolean
}

export function shouldPollMobilePairingDevices({
  deviceCountAtQr,
  currentDeviceCount,
  visibilityState,
  focused
}: MobilePairingDevicePollState): boolean {
  return (
    deviceCountAtQr !== null &&
    currentDeviceCount <= deviceCountAtQr &&
    visibilityState === 'visible' &&
    focused
  )
}

export function useMobilePairingDevicePolling({
  deviceCountAtQr,
  currentDeviceCount,
  loadDevices
}: {
  deviceCountAtQr: number | null
  currentDeviceCount: number
  loadDevices: () => Promise<void>
}): void {
  useEffect(() => {
    if (deviceCountAtQr === null || currentDeviceCount > deviceCountAtQr) {
      return
    }

    let stopped = false
    let pollInFlight = false
    let timeoutId: number | null = null

    const clearPendingPoll = (): void => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    const canPoll = (): boolean =>
      shouldPollMobilePairingDevices({
        deviceCountAtQr,
        currentDeviceCount,
        visibilityState: document.visibilityState,
        focused: document.hasFocus()
      })

    const scheduleNextPoll = (): void => {
      clearPendingPoll()
      if (stopped || !canPoll()) {
        return
      }
      timeoutId = window.setTimeout(() => {
        timeoutId = null
        if (stopped || !canPoll()) {
          return
        }
        if (pollInFlight) {
          scheduleNextPoll()
          return
        }
        pollInFlight = true
        // Why: wait for each IPC call to settle before scheduling the next
        // poll, avoiding overlapping device-list requests on a slow host.
        void loadDevices().finally(() => {
          pollInFlight = false
          scheduleNextPoll()
        })
      }, MOBILE_PAIRING_DEVICE_POLL_MS)
    }

    const resumePolling = (): void => {
      if (!canPoll()) {
        clearPendingPoll()
        return
      }
      if (pollInFlight) {
        return
      }
      pollInFlight = true
      void loadDevices().finally(() => {
        pollInFlight = false
        scheduleNextPoll()
      })
    }

    scheduleNextPoll()
    window.addEventListener('focus', resumePolling)
    document.addEventListener('visibilitychange', resumePolling)
    return () => {
      stopped = true
      clearPendingPoll()
      window.removeEventListener('focus', resumePolling)
      document.removeEventListener('visibilitychange', resumePolling)
    }
  }, [deviceCountAtQr, currentDeviceCount, loadDevices])
}
