import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'

export type OrcaCliFeatureTipSource = EventProps<'orca_cli_feature_tip_shown'>['source']
export type OrcaCliFeatureTipSetupResult = EventProps<'orca_cli_feature_tip_setup_result'>['result']

export function getOrcaCliFeatureTipTelemetrySource(value: unknown): OrcaCliFeatureTipSource {
  return value === 'app_open' ? 'app_open' : 'manual'
}

export function trackOrcaCliFeatureTipShown(source: OrcaCliFeatureTipSource): void {
  track('orca_cli_feature_tip_shown', { source })
}

export function trackOrcaCliFeatureTipSetupClicked(source: OrcaCliFeatureTipSource): void {
  track('orca_cli_feature_tip_setup_clicked', { source })
}

export function trackOrcaCliFeatureTipSetupResult(
  source: OrcaCliFeatureTipSource,
  result: OrcaCliFeatureTipSetupResult
): void {
  track('orca_cli_feature_tip_setup_result', { source, result })
}
