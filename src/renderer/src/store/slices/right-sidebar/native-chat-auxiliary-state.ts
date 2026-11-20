import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { ActiveRightSidebarTab } from '../../../../../shared/ui-chrome/ui-chrome-types'

/** The standalone chat a side chat belongs to; identity is its session, host, and live tab. */
export type NativeChatAuxiliaryParent = {
  sessionId: string
  tabId: string
  worktreeId: string
  target: RuntimeClientTarget
  agent: AgentType
}

/** A live, unlisted child conversation; never a main tab and never persisted. */
export type NativeChatAuxiliaryChild = {
  sessionId: string
  parentSessionId: string
  parentTabId: string
  worktreeId: string
  target: RuntimeClientTarget
  agent: TuiAgent
  /** The free "Side chat N" slot it holds while live. */
  titleNumber: number
  createdAt: number
}

export type NativeChatAuxiliaryConversation = {
  key: string
  parentSessionId: string
  parentTabId: string
  worktreeId: string
  target: RuntimeClientTarget
  agent: TuiAgent
  children: readonly NativeChatAuxiliaryChild[]
  activeChildSessionId: string | null
}

export type NativeChatAuxiliaryStoreState = {
  /** Per window; memory only, keyed by parent identity and host. */
  nativeChatAuxiliaryByParent: Record<string, NativeChatAuxiliaryConversation>
}

export type NativeChatAuxiliaryState = NativeChatAuxiliaryStoreState & {
  addNativeChatAuxiliaryChild: (
    parent: NativeChatAuxiliaryParent,
    child: NativeChatAuxiliaryChild
  ) => void
  setActiveNativeChatAuxiliaryChild: (key: string, sessionId: string | null) => void
  removeNativeChatAuxiliaryChild: (key: string, sessionId: string) => void
}

/** Same parent session on another host is another conversation. */
export function nativeChatAuxiliaryParentKey(
  parent: Pick<NativeChatAuxiliaryParent, 'sessionId' | 'target'>
): string {
  return `${executionHostKey(parent.target)}\u0000${parent.sessionId}`
}

export function nativeChatAuxiliaryTabId(childSessionId: string): string {
  return `side-chat-${childSessionId}`
}

export function nativeChatAuxiliaryNextTitleNumber(
  children: readonly NativeChatAuxiliaryChild[]
): number {
  const used = new Set(children.map((child) => child.titleNumber))
  let number = 1
  while (used.has(number)) {
    number += 1
  }
  return number
}

function executionHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

export function selectNativeChatAuxiliaryConversation(
  state: Pick<NativeChatAuxiliaryStoreState, 'nativeChatAuxiliaryByParent'>,
  parent: Pick<NativeChatAuxiliaryParent, 'sessionId' | 'target'>
): NativeChatAuxiliaryConversation | undefined {
  return state.nativeChatAuxiliaryByParent[nativeChatAuxiliaryParentKey(parent)]
}

export function selectNativeChatAuxiliaryChild(
  state: Pick<NativeChatAuxiliaryStoreState, 'nativeChatAuxiliaryByParent'>,
  parent: Pick<NativeChatAuxiliaryParent, 'sessionId' | 'target'>,
  sessionId: string
): NativeChatAuxiliaryChild | null {
  return (
    selectNativeChatAuxiliaryConversation(state, parent)?.children.find(
      (child) => child.sessionId === sessionId
    ) ?? null
  )
}

export function selectNativeChatAuxiliaryActiveChild(
  state: Pick<NativeChatAuxiliaryStoreState, 'nativeChatAuxiliaryByParent'>,
  parent: Pick<NativeChatAuxiliaryParent, 'sessionId' | 'target'>
): NativeChatAuxiliaryChild | null {
  const conversation = selectNativeChatAuxiliaryConversation(state, parent)
  return (
    conversation?.children.find((child) => child.sessionId === conversation.activeChildSessionId) ??
    null
  )
}

type NativeChatAuxiliaryPanelState = NativeChatAuxiliaryStoreState & {
  rightSidebarOpen: boolean
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarEffectiveTab: ActiveRightSidebarTab | null
}

/** The panel owns the screen; a parent chat must not reclaim focus while it does. */
export function selectNativeChatAuxiliaryOpen(state: NativeChatAuxiliaryPanelState): boolean {
  const shownTab = state.rightSidebarEffectiveTab ?? state.rightSidebarTab
  if (!state.rightSidebarOpen || shownTab !== 'side-chat') {
    return false
  }
  return Object.values(state.nativeChatAuxiliaryByParent).some(
    (conversation) => conversation.activeChildSessionId !== null
  )
}

/** Same panel state, scoped to one parent for a chat's own focus/blocking. */
export function selectNativeChatAuxiliaryOpenForParent(
  state: NativeChatAuxiliaryPanelState,
  parent: Pick<NativeChatAuxiliaryParent, 'sessionId' | 'target'>
): boolean {
  const shownTab = state.rightSidebarEffectiveTab ?? state.rightSidebarTab
  return (
    state.rightSidebarOpen &&
    shownTab === 'side-chat' &&
    selectNativeChatAuxiliaryActiveChild(state, parent) !== null
  )
}
