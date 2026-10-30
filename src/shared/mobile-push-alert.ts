import {
  MOBILE_PUSH_SOURCES,
  type MobilePushAgentState,
  type MobilePushFilter
} from './mobile-push-contract'

type AlertEvent = {
  type: string
  source?: string
  agentState?: string
  desktopAllowed?: boolean
  desktopAway?: boolean
  notificationSeq?: number
  notificationEpoch?: string
  title?: string
  body?: string
}

function clip(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`
}

export function mapPushAgentState(
  source: string,
  state: string | undefined
): MobilePushAgentState | null | undefined {
  if (source !== 'agent-task-complete') {
    return null
  }
  if (state === 'blocked' || state === 'waiting' || state === 'needs-input') {
    return 'needs-input'
  }
  return state === undefined || state === 'done' || state === 'finished' ? 'finished' : undefined
}

export function allowsMobilePushDelivery(filter: MobilePushFilter, event: AlertEvent): boolean {
  return (
    event.type === 'notification' &&
    event.desktopAllowed !== false &&
    (!filter.onlyWhenDesktopAway || event.desktopAway !== false)
  )
}

export function mobilePushAlertContent(event: AlertEvent) {
  const source = MOBILE_PUSH_SOURCES.find((candidate) => candidate === event.source)
  if (
    !source ||
    event.notificationSeq === undefined ||
    event.notificationEpoch === undefined ||
    typeof event.title !== 'string' ||
    typeof event.body !== 'string'
  ) {
    return null
  }
  const agentState = mapPushAgentState(source, event.agentState)
  return agentState === undefined
    ? null
    : {
        source,
        agentState,
        notificationSeq: event.notificationSeq,
        notificationEpoch: event.notificationEpoch,
        title: clip(event.title, 80),
        body: clip(event.body, 180)
      }
}
