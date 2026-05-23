import { useEffect, useState } from 'react'
import type { FeatureWallOpenSourceTelemetry } from '../../../../shared/telemetry-events'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function getFeatureWallOpenSource(
  modalData: Record<string, unknown>
): FeatureWallOpenSourceTelemetry {
  const source = modalData.source
  return source === 'help_menu' || source === 'popup' || source === 'onboarding'
    ? source
    : 'unknown'
}

export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return false
    }
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return
    }
    const media = window.matchMedia(REDUCED_MOTION_QUERY)
    setPrefersReducedMotion(media.matches)
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersReducedMotion(event.matches)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return prefersReducedMotion
}
