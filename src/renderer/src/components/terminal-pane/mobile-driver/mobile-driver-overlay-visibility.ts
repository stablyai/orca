import type { FitHoldMode } from '@/lib/pane-manager/mobile-fit-overrides'

export function shouldShowMobileDriverOverlay(
  driverKind: 'idle' | 'desktop' | 'mobile',
  fitMode: FitHoldMode | null
): boolean {
  return driverKind === 'mobile' || fitMode === 'mobile-fit'
}
