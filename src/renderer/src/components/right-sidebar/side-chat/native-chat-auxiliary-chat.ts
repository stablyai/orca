import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import {
  nativeChatAuxiliaryParentKey,
  nativeChatAuxiliaryTabId,
  selectNativeChatAuxiliaryActiveChild,
  selectNativeChatAuxiliaryChild,
  type NativeChatAuxiliaryChild,
  type NativeChatAuxiliaryParent
} from '@/store/slices/right-sidebar/native-chat-auxiliary-state'
import { canShowRightSidebarForView } from '../visibility/right-sidebar-visibility'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { addNativeChatAuxiliaryReference } from '@/components/native-chat/selection-quotes/native-chat-auxiliary-references'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import {
  nativeChatAuxiliaryParentSelected,
  readActiveNativeChatAuxiliaryParent
} from './native-chat-auxiliary-parent'
import { requestNativeChatAuxiliaryFocus } from './native-chat-auxiliary-focus-intent'
import { ensureNativeChatAuxiliaryChildRoutable } from './native-chat-auxiliary-lifecycle'
import {
  createNativeChatAuxiliaryChild,
  type NativeChatAuxiliaryCreateOutcome,
  type NativeChatAuxiliaryReferenceInput
} from './native-chat-auxiliary-create'
import {
  nativeChatAuxiliaryAgentSupported,
  nativeChatAuxiliaryViewportAllowsSideChat
} from './native-chat-auxiliary-availability'

export type {
  NativeChatAuxiliaryChild,
  NativeChatAuxiliaryParent
} from '@/store/slices/right-sidebar/native-chat-auxiliary-state'
export type {
  NativeChatAuxiliaryCreateOutcome,
  NativeChatAuxiliaryReferenceInput
} from './native-chat-auxiliary-create'
export type { NativeChatAuxiliaryChildGuard } from './native-chat-auxiliary-lifecycle'
export { closeNativeChatAuxiliaryChild } from './native-chat-auxiliary-lifecycle'
export { ensureNativeChatAuxiliaryChildRoutable }
export {
  NATIVE_CHAT_AUXILIARY_MIN_VIEWPORT_WIDTH_PX,
  useNativeChatAuxiliaryAvailability,
  useNativeChatAuxiliaryAvailable
} from './native-chat-auxiliary-availability'
export {
  selectNativeChatAuxiliaryOpen,
  selectNativeChatAuxiliaryOpenForParent
} from '@/store/slices/right-sidebar/native-chat-auxiliary-state'

export type OpenNativeChatAuxiliaryArgs = {
  parent: NativeChatAuxiliaryParent
  question?: string
  reference?: NativeChatAuxiliaryReferenceInput
}

/** `started` mirrors the existing side-chat action; refusal text is already localized. */
export type NativeChatAuxiliaryOpenResult =
  | { started: boolean; sessionId?: string }
  | { refused: string }

const referenceCreates = new Map<string, Promise<NativeChatAuxiliaryCreateOutcome>>()

function refusalText(key: string, fallback: string): string {
  return translate(`components.rightSidebar.sideChat.${key}`, fallback)
}

function parentRefusal(parent: NativeChatAuxiliaryParent): string | null {
  if (!nativeChatAuxiliaryAgentSupported(parent.agent)) {
    return translate(
      'components.rightSidebar.sideChat.agentUnsupported',
      'Side chats are available in OMP chats.'
    )
  }
  const state = useAppStore.getState()
  const active = readActiveNativeChatAuxiliaryParent(state)
  if (
    active === null ||
    active.tabId !== parent.tabId ||
    active.worktreeId !== parent.worktreeId ||
    nativeChatAuxiliaryParentKey(active) !== nativeChatAuxiliaryParentKey(parent)
  ) {
    return translate(
      'components.rightSidebar.sideChat.notActive',
      'Bring this chat into focus before starting a side chat.'
    )
  }
  if (!canShowRightSidebarForView(state.activeView)) {
    return translate(
      'components.rightSidebar.sideChat.viewUnsupported',
      'Side chats are available in the workspace.'
    )
  }
  if (
    typeof window === 'undefined' ||
    !nativeChatAuxiliaryViewportAllowsSideChat(window.innerWidth)
  ) {
    return translate('components.rightSidebar.sideChat.narrow', 'Side chats need a wider window.')
  }
  return null
}

/** Route only while the source chat still owns the focused split; a parent change never steals focus. */
function routeToSelectedChild(
  parent: NativeChatAuxiliaryParent,
  child: NativeChatAuxiliaryChild
): void {
  const state = useAppStore.getState()
  if (
    !nativeChatAuxiliaryParentSelected(state, parent) ||
    selectNativeChatAuxiliaryChild(state, parent, child.sessionId) === null
  ) {
    return
  }
  requestNativeChatAuxiliaryFocus(child.sessionId)
  state.showRightSidebarSideChat()
  state.setActiveNativeChatAuxiliaryChild(nativeChatAuxiliaryParentKey(parent), child.sessionId)
  requestNativeChatComposerFocus(nativeChatAuxiliaryTabId(child.sessionId))
}

function addReferenceToChild(
  parent: NativeChatAuxiliaryParent,
  child: NativeChatAuxiliaryChild,
  reference: NativeChatAuxiliaryReferenceInput
): NativeChatAuxiliaryOpenResult {
  // A child removed between the status guard and the write must not receive stale context.
  if (selectNativeChatAuxiliaryChild(useAppStore.getState(), parent, child.sessionId) === null) {
    return {
      refused: refusalText('childUnavailable', 'That side chat is no longer available.')
    }
  }
  const added = addNativeChatAuxiliaryReference(
    structuredAgentSessionDraftScopeKey(child.sessionId),
    {
      sourceSessionId: parent.sessionId,
      sourceRowId: reference.sourceRowId,
      text: reference.text
    }
  )
  if (added === 'limit') {
    return {
      refused: refusalText('referenceLimit', 'That selection is too long to add to a side chat.')
    }
  }
  routeToSelectedChild(parent, child)
  return { started: true, sessionId: child.sessionId }
}

/** The child created by a shared request, found by that request's receipt, never by chance. */
function childFromCreateOutcome(
  parent: NativeChatAuxiliaryParent,
  outcome: NativeChatAuxiliaryCreateOutcome
): NativeChatAuxiliaryChild | null {
  return 'child' in outcome
    ? selectNativeChatAuxiliaryChild(useAppStore.getState(), parent, outcome.child.sessionId)
    : null
}

async function openReferenceSideChat(
  parent: NativeChatAuxiliaryParent,
  reference: NativeChatAuxiliaryReferenceInput
): Promise<NativeChatAuxiliaryOpenResult> {
  const state = useAppStore.getState()
  const shownTab = state.rightSidebarEffectiveTab ?? state.rightSidebarTab
  if (state.rightSidebarOpen && shownTab === 'side-chat') {
    const activeChild = selectNativeChatAuxiliaryActiveChild(state, parent)
    if (activeChild) {
      const guard = await ensureNativeChatAuxiliaryChildRoutable(activeChild)
      if (guard.kind === 'blocked') {
        return { refused: guard.reason }
      }
      if (guard.kind === 'ok') {
        return addReferenceToChild(parent, activeChild, reference)
      }
    }
  }
  const key = nativeChatAuxiliaryParentKey(parent)
  const pending = referenceCreates.get(key)
  if (pending) {
    const outcome = await pending
    if ('refused' in outcome) {
      return { refused: outcome.refused }
    }
    const child = childFromCreateOutcome(parent, outcome)
    return child
      ? addReferenceToChild(parent, child, reference)
      : { refused: refusalText('createFailed', "The side chat couldn't start. Try again.") }
  }
  const creation = createNativeChatAuxiliaryChild(parent, undefined, reference)
  referenceCreates.set(key, creation)
  try {
    const outcome = await creation
    if ('refused' in outcome) {
      return { refused: outcome.refused }
    }
    const child = childFromCreateOutcome(parent, outcome)
    return child
      ? addReferenceToChild(parent, child, reference)
      : { refused: refusalText('createFailed', "The side chat couldn't start. Try again.") }
  } finally {
    if (referenceCreates.get(key) === creation) {
      referenceCreates.delete(key)
    }
  }
}

/**
 * Opens a side chat beside `parent`: an explicit open or question always creates a new child; a
 * reference reuses only the currently active same-parent child, merging concurrent reference
 * creates so selections never fan out into duplicate chats.
 */
export async function openNativeChatAuxiliary({
  parent,
  question,
  reference
}: OpenNativeChatAuxiliaryArgs): Promise<NativeChatAuxiliaryOpenResult> {
  const refusal = parentRefusal(parent)
  if (refusal) {
    return { refused: refusal }
  }
  if (reference && question === undefined) {
    return openReferenceSideChat(parent, reference)
  }
  const outcome = await createNativeChatAuxiliaryChild(parent, question, reference)
  if ('refused' in outcome) {
    return { refused: outcome.refused }
  }
  routeToSelectedChild(parent, outcome.child)
  return { started: true, sessionId: outcome.child.sessionId }
}

export { useNativeChatAuxiliaryConversation } from './native-chat-auxiliary-hooks'
export {
  useNativeChatAuxiliaryOpen,
  useNativeChatAuxiliaryOpenForParent,
  useNativeChatAuxiliaryReferenceBlockedReason
} from './native-chat-auxiliary-hooks'
