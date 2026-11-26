import { parseBotAddress } from '../bot-roster'

export const BOT_HANDOFF_LAUNCH_RELAY_REFUSAL =
  'Model and effort overrides cannot be relayed to another runtime. Nothing was sent.'

export function botHandoffLaunchRouteError(params: {
  to?: string
  type?: string
  chat?: string
  item?: unknown
  on?: unknown
  onClient?: string
  model?: string
  effort?: string
}): string | undefined {
  if (params.model === undefined && params.effort === undefined) {
    return undefined
  }
  if (params.model === undefined) {
    return '--effort requires --model.'
  }
  if (params.on !== undefined || params.onClient !== undefined) {
    return BOT_HANDOFF_LAUNCH_RELAY_REFUSAL
  }
  if (
    !params.to ||
    parseBotAddress(params.to) === null ||
    params.type !== 'handoff' ||
    params.chat !== 'new' ||
    params.item !== undefined
  ) {
    return '--model and --effort require --to bot:<name> --type handoff --chat new.'
  }
  return undefined
}
