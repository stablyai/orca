import type { AppState } from '@/store'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'

type LaunchDraftResolvedEvent = Extract<
  RuntimeClientEvent,
  { type: 'nativeChatLaunchDraftResolved' }
>

type LaunchDraftResolutionState = Pick<AppState, 'resolveNativeChatLaunchDraft'>

export function applyNativeChatLaunchDraftResolved(
  state: LaunchDraftResolutionState,
  event: LaunchDraftResolvedEvent
): void {
  state.resolveNativeChatLaunchDraft(event.tabId, {
    text: event.text,
    createdAt: event.createdAt
  })
}
