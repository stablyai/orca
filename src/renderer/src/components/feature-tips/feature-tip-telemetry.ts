import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'

export type OrcaCliFeatureTipSource = EventProps<'orca_cli_feature_tip_shown'>['source']
export type OrcaCliFeatureTipSetupResult = EventProps<'orca_cli_feature_tip_setup_result'>['result']
export type CmdJPaletteFeatureTipSource = EventProps<'cmd_j_palette_feature_tip_shown'>['source']

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

export function trackCmdJPaletteFeatureTipShown(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_shown', { source })
}

export function trackCmdJPaletteFeatureTipAcknowledged(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_acknowledged', { source })
}

export type ChatUiFeatureTipAction = EventProps<'chat_ui_feature_tip_action'>['action']
type ShownChatUiLaunchTipVariant = Exclude<ChatUiLaunchTipVariant, 'none'>

const CHAT_UI_TIP_TELEMETRY_VARIANT = {
  'chat-ui-off': 'chat_ui_off',
  'chat-ui-on': 'chat_ui_on'
} as const satisfies Record<
  ShownChatUiLaunchTipVariant,
  EventProps<'chat_ui_feature_tip_shown'>['variant']
>

export function trackChatUiFeatureTipShown(variant: ChatUiLaunchTipVariant): void {
  if (variant !== 'none') {
    track('chat_ui_feature_tip_shown', { variant: CHAT_UI_TIP_TELEMETRY_VARIANT[variant] })
  }
}

export function trackChatUiFeatureTipAction(
  variant: ChatUiLaunchTipVariant,
  action: ChatUiFeatureTipAction
): void {
  if (variant !== 'none') {
    track('chat_ui_feature_tip_action', { variant: CHAT_UI_TIP_TELEMETRY_VARIANT[variant], action })
  }
}
