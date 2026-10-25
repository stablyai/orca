import type { RefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  conversationReferenceToken,
  type ConversationReferenceCreate
} from '../../../../shared/conversation-reference'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { nativeChatComposerDraftWriteSettled } from './native-chat-composer-draft-persistence'
import { focusedNativeChatRoot } from './use-native-chat-root-input-routing'

/** A composer a conversation reference can land in, read live so a late answer sees what changed. */
export type ConversationReferenceComposer = {
  readonly scope: () => string
  readonly input: RefObject<NativeChatComposerInput | null>
  /** The composer's box, which tells whether it is on screen and which chat holds it. */
  readonly element: () => HTMLElement | null
  /** The paired server the chat runs on; undefined for a chat this desktop runs. */
  readonly environmentId: () => string | undefined
  readonly disabled: () => boolean
  readonly composing: () => boolean
}

const composers = new Set<ConversationReferenceComposer>()
// Keyed by draft, so a reference still being created follows its draft across remounts.
const pendingByScope = new Map<string, number>()
const pendingListeners = new Set<() => void>()

export function registerConversationReferenceComposer(
  composer: ConversationReferenceComposer
): () => void {
  composers.add(composer)
  return () => {
    composers.delete(composer)
  }
}

export function subscribeToConversationReferencePending(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => {
    pendingListeners.delete(listener)
  }
}

export function isConversationReferencePending(scope: string): boolean {
  return (pendingByScope.get(scope) ?? 0) > 0
}

function trackPending(scope: string, delta: 1 | -1): void {
  const count = (pendingByScope.get(scope) ?? 0) + delta
  if (count > 0) {
    pendingByScope.set(scope, count)
  } else {
    pendingByScope.delete(scope)
  }
  pendingListeners.forEach((listener) => listener())
}

function shownOnScreen(composer: ConversationReferenceComposer): boolean {
  const element = composer.element()
  return element !== null && element.isConnected && !element.closest('[inert], [hidden]')
}

type FocusedComposer =
  | { composer: ConversationReferenceComposer }
  | { refusal: 'none' | 'ambiguous' | 'unavailable' }

/** The composer of the chat visible in the focused group; never a guess between two. */
export function focusedConversationReferenceComposer(): FocusedComposer {
  const root = focusedNativeChatRoot()
  if (root === null || root === 'ambiguous') {
    return { refusal: root ?? 'none' }
  }
  const shown = [...composers].filter((composer) => {
    const element = composer.element()
    return element !== null && root.contains(element) && shownOnScreen(composer)
  })
  if (shown.length === 1) {
    return { composer: shown[0] }
  }
  return { refusal: shown.length === 0 ? 'unavailable' : 'ambiguous' }
}

function refusesSourceHost(
  source: ConversationReferenceCreate,
  environmentId: string | undefined
): boolean {
  return environmentId ? source.executionHostId !== toRuntimeExecutionHostId(environmentId) : false
}

function reportDifferentHost(): void {
  toast.error(
    translate(
      'components.native-chat.conversationReference.differentHost',
      'This agent cannot reach the conversation on its source host. Open the chat on that host to reference it.'
    )
  )
}

function reportError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

/**
 * Creates the reference and puts its pill at the caret of the editor captured now. Once the answer
 * lands, an editor that was replaced, hidden, disabled or mid-composition gets nothing; the token
 * goes to the captured draft instead, so it never lands in another chat's message.
 */
export function addConversationReferenceToComposer(
  composer: ConversationReferenceComposer,
  source: ConversationReferenceCreate
): Promise<void> {
  const environmentId = composer.environmentId()
  if (refusesSourceHost(source, environmentId)) {
    reportDifferentHost()
    return Promise.resolve()
  }
  const scope = composer.scope()
  const input = composer.input.current
  trackPending(scope, 1)
  return window.api.aiVault
    .createConversationReference(source)
    .then(async (reference) => {
      const token = `${conversationReferenceToken(reference)} `
      const editor = composer.input.current
      const sameEditor = editor !== null && editor === input && composer.scope() === scope
      if (sameEditor && composer.environmentId() !== environmentId) {
        reportDifferentHost()
        return
      }
      const element = composer.element()
      const root = element?.closest('[data-native-chat-root="true"]')
      const focusedRoot = focusedNativeChatRoot()
      const stillFocused = root === null ? focusedRoot === null : focusedRoot === root
      const onScreen = sameEditor && shownOnScreen(composer)
      if (
        onScreen &&
        stillFocused &&
        editor.insertText &&
        !composer.disabled() &&
        !composer.composing()
      ) {
        editor.focus()
        editor.insertText(token)
        return
      }
      const saved = appendNativeChatDraftCache(scope, token)
      const durable = saved && (await nativeChatComposerDraftWriteSettled(scope))
      if (!durable) {
        toast.error(
          translate(
            'components.native-chat.conversationReference.draftSaveFailed',
            'The conversation reference could not be saved to the target draft.'
          )
        )
      } else if (!onScreen || !stillFocused) {
        toast.success(
          translate(
            'components.native-chat.conversationReference.addedToDraft',
            'The conversation reference was added to the draft of the chat it was meant for.'
          )
        )
      }
    })
    .catch(reportError)
    .finally(() => trackPending(scope, -1))
}

/** A menu's Reference conversation: goes to the chat visible in the focused group, or nowhere. */
export function referenceConversationInFocusedChat(
  source: ConversationReferenceCreate | null
): Promise<void> {
  if (!source) {
    toast.error(
      translate(
        'components.native-chat.conversationReference.unavailable',
        'This conversation cannot be referenced.'
      )
    )
    return Promise.resolve()
  }
  const focused = focusedConversationReferenceComposer()
  if ('refusal' in focused) {
    toast.error(
      focused.refusal === 'none'
        ? translate(
            'components.native-chat.conversationReference.noComposer',
            'Open a chat to reference this conversation in its message box.'
          )
        : focused.refusal === 'ambiguous'
          ? translate(
              'components.native-chat.conversationReference.ambiguousComposer',
              'Click the message box of the chat to reference this conversation in, then try again.'
            )
          : translate(
              'components.native-chat.conversationReference.composerUnavailable',
              'The open chat cannot take a message right now.'
            )
    )
    return Promise.resolve()
  }
  const { composer } = focused
  if (composer.disabled() || composer.composing()) {
    toast.error(
      translate(
        'components.native-chat.conversationReference.composerUnavailable',
        'The open chat cannot take a message right now.'
      )
    )
    return Promise.resolve()
  }
  return addConversationReferenceToComposer(composer, source)
}

export function copyConversationReference(source: ConversationReferenceCreate): Promise<void> {
  return window.api.aiVault
    .createConversationReference(source)
    .then((reference) =>
      window.api.ui.writeTerminalClipboardText(conversationReferenceToken(reference))
    )
    .catch(reportError)
}
