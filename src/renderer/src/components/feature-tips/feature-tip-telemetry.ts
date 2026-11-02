import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import type { FeatureTipId } from '../../../../shared/feature-tips'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

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

/** Unenrolled profiles retain the original announcement behavior; treatment arms show unless targeting excludes them. */
export function isChatUiLaunchTipHeldOut(
  settings: Pick<GlobalSettings, 'telemetry'> | null
): boolean {
  const telemetry = settings?.telemetry
  const cohort = telemetry?.chatUiLaunchTipCohort
  return (
    cohort === 'control' ||
    ((cohort === 'treatment' ||
      cohort === 'treatment-live-switch' ||
      cohort === 'treatment-swapped-buttons' ||
      cohort === 'treatment-center') &&
      (telemetry?.chatUiLaunchTipTargeting?.mode === 'eligible-harnesses' ||
        telemetry?.chatUiLaunchTipTargeting?.mode === 'not-switched') &&
      telemetry?.chatUiLaunchTipTargeting?.eligible !== true)
  )
}

export function wasChatUiLaunchTipShown(
  seenTipIds: readonly FeatureTipId[],
  settings: Pick<GlobalSettings, 'telemetry'> | null
): boolean {
  return seenTipIds.includes('chat-ui-here') && !isChatUiLaunchTipHeldOut(settings)
}

export function trackChatUiFeatureTipExposure(
  variant: ChatUiLaunchTipVariant,
  settings: Pick<GlobalSettings, 'telemetry'> | null
): void {
  if (variant !== 'none') {
    track('chat_ui_feature_tip_exposure', {
      variant: CHAT_UI_TIP_TELEMETRY_VARIANT[variant],
      launch_tip_cohort: settings?.telemetry?.chatUiLaunchTipCohort ?? 'unassigned',
      shown: !isChatUiLaunchTipHeldOut(settings),
      ...(settings?.telemetry?.chatUiLaunchTipTargeting
        ? { targeting: settings.telemetry.chatUiLaunchTipTargeting.mode }
        : {})
    })
  }
}

export function trackAgentDefaultSurfaceChanged(
  props: EventProps<'agent_default_surface_changed'>
): void {
  if (props.from_mode !== props.to_mode) {
    track('agent_default_surface_changed', props)
  }
}
