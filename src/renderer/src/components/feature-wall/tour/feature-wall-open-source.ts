import type { FeatureWallOpenSourceTelemetry } from '../../../../../shared/telemetry-property-schemas'

export function getFeatureWallOpenSource(
  modalData: Record<string, unknown>
): FeatureWallOpenSourceTelemetry {
  const source = modalData.source
  return source === 'help_menu' || source === 'popup' || source === 'onboarding'
    ? source
    : 'unknown'
}
