import { useCallback, useEffect, useRef } from 'react'

const ROUTE_EDIT_GENERATION_DEBOUNCE_MS = 200

type GeneratePairing = (
  rotate: boolean,
  addressesOverride?: readonly string[],
  relayIndexOverride?: number
) => Promise<void>

export function useMobilePairingRouteEditGeneration(
  generatePairing: GeneratePairing,
  invalidatePairing: () => void
): {
  scheduleRouteEditGeneration: (addresses: readonly string[], relayIndex: number) => void
  cancelRouteEditGeneration: () => boolean
} {
  const generatePairingRef = useRef(generatePairing)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  generatePairingRef.current = generatePairing

  const cancelRouteEditGeneration = useCallback(() => {
    if (timerRef.current === null) {
      return false
    }
    clearTimeout(timerRef.current)
    timerRef.current = null
    return true
  }, [])

  const scheduleRouteEditGeneration = useCallback(
    (addresses: readonly string[], relayIndex: number) => {
      // Why: invalidate the old token immediately, but wait for drag/checkbox
      // input to settle before rotating Relay state and minting another QR.
      invalidatePairing()
      cancelRouteEditGeneration()
      const latestAddresses = [...addresses]
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void generatePairingRef.current(true, latestAddresses, relayIndex)
      }, ROUTE_EDIT_GENERATION_DEBOUNCE_MS)
    },
    [cancelRouteEditGeneration, invalidatePairing]
  )

  useEffect(
    () => () => {
      cancelRouteEditGeneration()
    },
    [cancelRouteEditGeneration]
  )

  return { scheduleRouteEditGeneration, cancelRouteEditGeneration }
}
