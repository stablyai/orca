import { useMemo } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { canShowRightSidebarForView } from '../visibility/right-sidebar-visibility'
import { useWindowWidth } from '../layout/use-window-width'
import { nativeChatAuxiliaryParentSelected } from './native-chat-auxiliary-parent'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatAuxiliaryParent } from '@/store/slices/right-sidebar/native-chat-auxiliary-state'

import { AGENT_SESSION_CREATE_AUXILIARY_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
export { AGENT_SESSION_CREATE_AUXILIARY_RUNTIME_CAPABILITY }

/** Below this the right panel would leave too little conversation to compare side by side. */
export const NATIVE_CHAT_AUXILIARY_MIN_VIEWPORT_WIDTH_PX = 900

export type NativeChatAuxiliaryAvailability = {
  available: boolean
  reason: string | null
}

/** OMP is the first stable-snapshot provider; others stay unavailable until they prove one. */
export function nativeChatAuxiliaryAgentSupported(agent: AgentType): agent is TuiAgent {
  return isTuiAgent(agent) && agent === 'omp'
}

export function nativeChatAuxiliaryViewportAllowsSideChat(width: number | null): boolean {
  return width !== null && width >= NATIVE_CHAT_AUXILIARY_MIN_VIEWPORT_WIDTH_PX
}

export type NativeChatAuxiliaryAvailabilityState = {
  parent: NativeChatAuxiliaryParent | null
  selected: boolean
  agentSupported: boolean
  viewportAllows: boolean
  viewAllows: boolean
  hostSupports: boolean
}

export type NativeChatAuxiliaryAvailabilityKind =
  | 'available'
  | 'no-parent'
  | 'inactive'
  | 'agent'
  | 'viewport'
  | 'view'
  | 'host'

/** The shared gate for commands, context actions, the panel, and the open path. */
export function nativeChatAuxiliaryAvailabilityKind(
  state: NativeChatAuxiliaryAvailabilityState
): NativeChatAuxiliaryAvailabilityKind {
  if (!state.parent) {
    return 'no-parent'
  }
  if (!state.agentSupported) {
    return 'agent'
  }
  if (!state.selected) {
    return 'inactive'
  }
  if (!state.viewAllows) {
    return 'view'
  }
  if (!state.viewportAllows) {
    return 'viewport'
  }
  return state.hostSupports ? 'available' : 'host'
}

function reasonText(kind: NativeChatAuxiliaryAvailabilityKind, t: Translate): string | null {
  switch (kind) {
    case 'available':
      return null
    case 'no-parent':
      return t(
        'components.rightSidebar.sideChat.openChat',
        'Open an OMP chat to start a side chat.'
      )
    case 'agent':
      return t(
        'components.rightSidebar.sideChat.agentUnsupported',
        'Side chats are available in OMP chats.'
      )
    case 'inactive':
      return t(
        'components.rightSidebar.sideChat.notActive',
        'Bring this chat into focus before starting a side chat.'
      )
    case 'viewport':
      return t('components.rightSidebar.sideChat.narrow', 'Side chats need a wider window.')
    case 'view':
      return t(
        'components.rightSidebar.sideChat.viewUnsupported',
        'Side chats are available in the workspace.'
      )
    case 'host':
      return t(
        'components.rightSidebar.sideChat.hostOlder',
        'This host runs an older Orca. Update it to use side chats.'
      )
    default:
      return null
  }
}

/**
 * Availability for a source chat. Pass `null` when its split is hidden or unfocused so a stale
 * pane neither probes the host nor keeps a capability subscription alive.
 */
export function useNativeChatAuxiliaryAvailability(
  parent: NativeChatAuxiliaryParent | null
): NativeChatAuxiliaryAvailability {
  const t = useTranslate()
  const windowWidth = useWindowWidth()
  const selected = useAppStore((state) =>
    parent ? nativeChatAuxiliaryParentSelected(state, parent) : false
  )
  const viewAllows = useAppStore((state) => canShowRightSidebarForView(state.activeView))
  const hostState = useStructuredAgentSessionHostCapabilityState(
    parent?.target ?? null,
    AGENT_SESSION_CREATE_AUXILIARY_RUNTIME_CAPABILITY
  )
  return useMemo(() => {
    const kind = nativeChatAuxiliaryAvailabilityKind({
      parent,
      selected,
      agentSupported: parent !== null && nativeChatAuxiliaryAgentSupported(parent.agent),
      viewportAllows: nativeChatAuxiliaryViewportAllowsSideChat(windowWidth),
      viewAllows,
      hostSupports: hostState === 'supported'
    })
    return { available: kind === 'available', reason: reasonText(kind, t) }
  }, [hostState, parent, selected, t, viewAllows, windowWidth])
}

export function useNativeChatAuxiliaryAvailable(parent: NativeChatAuxiliaryParent | null): boolean {
  return useNativeChatAuxiliaryAvailability(parent).available
}
