import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import { mayHoldAgentReferences } from '../../../../shared/orchestration-agent-reference'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat/input/native-chat-slash-commands'
import {
  NATIVE_CHAT_SIDE_CHAT_COMMANDS,
  parseNativeChatSideChatDraft,
  withNativeChatSideChatCommands
} from '../../../../shared/native-chat/input/native-chat-side-chat-command'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import { nativeChatPendingAttachmentSnapshot } from './native-chat-pending-attachment-cache'
import { NATIVE_CHAT_PASTED_TEXT_TOKEN } from './native-chat-pasted-text-reference'
import {
  clearNativeChatComposerDraftIfUnchanged,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import {
  writeNativeChatComposerText,
  type NativeChatComposerInput
} from './native-chat-composer-input'

export function withNativeChatSideChatRows(
  commands: readonly SlashCommandSuggestion[],
  notReadyReason: string | null
): SlashCommandSuggestion[] {
  const side = translate(
    'components.native-chat.sideChat.description',
    'Ask a side question in a fork beside this chat'
  )
  return withNativeChatSideChatCommands(commands, {
    side,
    btw: side,
    argumentHint: translate('components.native-chat.sideChat.argumentHint', '<question>'),
    unavailableReason: notReadyReason
  })
}

export type NativeChatSideChatCommand = {
  matchesDraft: (draft: string) => boolean
  /** Starts a side chat for a `/side` or `/btw` draft; false means the draft is not Orca's. */
  consume: (draft: string) => boolean
  /** Choosing the row puts `/btw ` in the composer for the question; only Send runs it. */
  interceptPick: <TItem extends NativeChatPickerItem>(
    pick: (item: TItem) => void
  ) => (item: TItem) => void
}

/** In a structured chat that can fork, `/btw question` asks it in a fork beside the chat and never
 *  reaches the agent. The draft stays until the question went out. */
export function useNativeChatSideChatCommand(args: {
  structuredTransport: NativeChatStructuredComposerTransport | undefined
  picker: Pick<NativeChatPickerState, 'autocomplete' | 'isPickedSkill'>
  editor: {
    textareaRef: RefObject<NativeChatComposerInput | null>
    setDraft: (value: string) => void
    setCaret: Dispatch<SetStateAction<number>>
  }
}): NativeChatSideChatCommand {
  const { structuredTransport } = args
  const { autocomplete, isPickedSkill } = args.picker
  const { textareaRef, setDraft, setCaret } = args.editor
  const sideChat = structuredTransport?.sideChat
  const matchesDraft = useCallback(
    (draft: string) =>
      sideChat !== undefined &&
      !isPickedSkill(draft) &&
      parseNativeChatSideChatDraft(draft) !== null,
    [isPickedSkill, sideChat]
  )
  const consume = useCallback(
    (draft: string): boolean => {
      const command = parseNativeChatSideChatDraft(draft)
      if (!structuredTransport || !sideChat || !command || isPickedSkill(draft)) {
        return false
      }
      const { onError, sessionId } = structuredTransport
      const draftScopeKey = structuredAgentSessionDraftScopeKey(sessionId)
      const submitted = readNativeChatComposerDraft(draftScopeKey)
      if (
        submitted.images.length > 0 ||
        nativeChatPendingAttachmentSnapshot(draftScopeKey).length > 0 ||
        NATIVE_CHAT_PASTED_TEXT_TOKEN.test(draft) ||
        mayHoldAgentReferences(draft)
      ) {
        onError(
          translate(
            'components.native-chat.sideChat.textOnly',
            'Side chats take text only. Remove attachments, then send it again.'
          )
        )
        return true
      }
      const isCurrent = structuredTransport.capturePresentation()
      void sideChat.open(command.question).then((result) => {
        if ('refused' in result) {
          if (isCurrent()) {
            onError(result.refused)
          }
          return
        }
        if (result.started && clearNativeChatComposerDraftIfUnchanged(draftScopeKey, submitted)) {
          if (isCurrent()) {
            onError(null)
            setCaret(0)
          }
        }
      })
      return true
    },
    [isPickedSkill, setCaret, sideChat, structuredTransport]
  )
  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        const leading = autocomplete.mode === 'slash' && autocomplete.dispatchable
        const name = item.kind === 'command' && item.orcaOwned ? item.name : null
        if (
          !leading ||
          !sideChat ||
          !(NATIVE_CHAT_SIDE_CHAT_COMMANDS as readonly (string | null)[]).includes(name)
        ) {
          pick(item)
          return
        }
        const text = `/${name} `
        setDraft(text)
        setCaret(text.length)
        const input = textareaRef.current
        if (input) {
          writeNativeChatComposerText(input, text, text.length)
        }
      },
    [autocomplete, setCaret, setDraft, sideChat, textareaRef]
  )
  return { matchesDraft, consume, interceptPick }
}
