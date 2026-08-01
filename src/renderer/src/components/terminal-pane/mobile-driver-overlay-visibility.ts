import type { FitHoldMode } from '@/lib/pane-manager/mobile-fit-overrides'

export function shouldShowMobileDriverOverlay(
  driverKind: 'idle' | 'desktop' | 'mobile' | 'peer',
  fitMode: FitHoldMode | null
): boolean {
  return driverKind === 'mobile' || driverKind === 'peer' || fitMode === 'mobile-fit'
}
