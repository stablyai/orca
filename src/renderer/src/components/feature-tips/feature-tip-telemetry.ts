import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'

export type MCodeCliFeatureTipSource = EventProps<'mcode_cli_feature_tip_shown'>['source']
export type MCodeCliFeatureTipSetupResult = EventProps<'mcode_cli_feature_tip_setup_result'>['result']
export type CmdJPaletteFeatureTipSource = EventProps<'cmd_j_palette_feature_tip_shown'>['source']

export function getMCodeCliFeatureTipTelemetrySource(value: unknown): MCodeCliFeatureTipSource {
  return value === 'app_open' ? 'app_open' : 'manual'
}

export function trackMCodeCliFeatureTipShown(source: MCodeCliFeatureTipSource): void {
  track('mcode_cli_feature_tip_shown', { source })
}

export function trackMCodeCliFeatureTipSetupClicked(source: MCodeCliFeatureTipSource): void {
  track('mcode_cli_feature_tip_setup_clicked', { source })
}

export function trackMCodeCliFeatureTipSetupResult(
  source: MCodeCliFeatureTipSource,
  result: MCodeCliFeatureTipSetupResult
): void {
  track('mcode_cli_feature_tip_setup_result', { source, result })
}

export function trackCmdJPaletteFeatureTipShown(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_shown', { source })
}

export function trackCmdJPaletteFeatureTipAcknowledged(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_acknowledged', { source })
}
