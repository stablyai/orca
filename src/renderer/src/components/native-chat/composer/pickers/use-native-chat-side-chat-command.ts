import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import { mayHoldAgentReferences } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import type { SlashCommandSuggestion } from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import {
  isNativeChatSideChatCommand,
  nativeChatProviderOwnsSideCommand,
  parseNativeChatSideChatDraft,
  withNativeChatSideChatCommands
} from '../../../../../../shared/native-chat/input/commands/native-chat-side-chat-command'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import { nativeChatPendingAttachmentSnapshot } from '../../attachments/chips/native-chat-pending-attachment-cache'
import { NATIVE_CHAT_PASTED_TEXT_TOKEN } from '../../paste/native-chat-pasted-text-reference'
import {
  clearNativeChatComposerDraftIfUnchanged,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
import { promptHasAttachmentReferences } from '../editor/native-chat-prompt-document'
import { nativeChatAuxiliaryReferenceSnapshot } from '../../selection-quotes/native-chat-auxiliary-references'
import type { NativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-storage'

export function withNativeChatSideChatRows(
  commands: readonly SlashCommandSuggestion[],
  notReadyReason: string | null,
  providerOwns?: (name: string) => boolean
): SlashCommandSuggestion[] {
  const side = translate(
    'components.native-chat.sideChat.description',
    'Ask a question in a separate chat'
  )
  return withNativeChatSideChatCommands(
    commands,
    {
      side,
      btw: side,
      argumentHint: translate('components.native-chat.sideChat.argumentHint', '<question>'),
      unavailableReason: notReadyReason
    },
    providerOwns
  )
}

export type NativeChatSideChatCommand = {
  matchesDraft: (draft: string) => boolean
  /** Starts a side chat for a `/side` or `/btw` draft; false means the draft is not Orca's. */
  consume: (draft: string) => boolean
  /** A bare auxiliary command opens immediately; the legacy fork action completes the token. */
  interceptPick: <TItem extends NativeChatPickerItem>(
    pick: (item: TItem) => void
  ) => (item: TItem) => void
}

function supportsSideChatDraft(scope: string, draft: NativeChatComposerDraft): boolean {
  return (
    draft.images.length === 0 &&
    nativeChatPendingAttachmentSnapshot(scope).length === 0 &&
    nativeChatAuxiliaryReferenceSnapshot(scope).length === 0 &&
    !promptHasAttachmentReferences(draft.document) &&
    !NATIVE_CHAT_PASTED_TEXT_TOKEN.test(draft.text) &&
    !mayHoldAgentReferences(draft.text)
  )
}

/** A side question leaves the parent draft only after the child accepted it. */
export function useNativeChatSideChatCommand(args: {
  structuredTransport:
    | Pick<
        NativeChatStructuredComposerTransport,
        'sessionId' | 'onError' | 'capturePresentation' | 'sideChat' | 'sessionCommands'
      >
    | undefined
  picker: Pick<NativeChatPickerState, 'isPickedSkill' | 'completeItem'> & {
    autocomplete: { mode: string; dispatchable?: boolean }
  }
  editor: { setCaret: Dispatch<SetStateAction<number>> }
  disabled: boolean
}): NativeChatSideChatCommand {
  const { structuredTransport } = args
  const { autocomplete, isPickedSkill, completeItem } = args.picker
  const { setCaret } = args.editor
  const sideChat = structuredTransport?.sideChat
  const scope =
    structuredTransport && structuredAgentSessionDraftScopeKey(structuredTransport.sessionId)
  const matchesDraft = useCallback(
    (draft: string) => {
      const command = parseNativeChatSideChatDraft(draft)
      if (!sideChat || !scope || isPickedSkill(draft) || !command) {
        return false
      }
      return (
        !sideChat.auxiliary ||
        (!nativeChatProviderOwnsSideCommand(structuredTransport?.sessionCommands, command.name) &&
          supportsSideChatDraft(scope, readNativeChatComposerDraft(scope)))
      )
    },
    [isPickedSkill, scope, sideChat, structuredTransport?.sessionCommands]
  )
  const open = useCallback(
    (question: string, submitted: NativeChatComposerDraft) => {
      if (!structuredTransport || !sideChat || !scope) {
        return
      }
      const { onError } = structuredTransport
      const isCurrent = structuredTransport.capturePresentation()
      void sideChat.open(question).then((result) => {
        if ('refused' in result) {
          if (isCurrent()) {
            onError(result.refused)
          }
          return
        }
        if (result.started && clearNativeChatComposerDraftIfUnchanged(scope, submitted)) {
          if (isCurrent()) {
            onError(null)
            setCaret(0)
          }
        }
      })
    },
    [scope, setCaret, sideChat, structuredTransport]
  )
  const consume = useCallback(
    (draft: string): boolean => {
      const command = parseNativeChatSideChatDraft(draft)
      if (!scope || !command || !matchesDraft(draft)) {
        return false
      }
      const submitted = readNativeChatComposerDraft(scope)
      if (supportsSideChatDraft(scope, submitted)) {
        open(command.question, submitted)
      } else {
        structuredTransport?.onError(
          translate(
            'components.native-chat.sideChat.textOnly',
            'Side chats take text only. Remove attachments, then send it again.'
          )
        )
      }
      return true
    },
    [matchesDraft, open, scope, structuredTransport]
  )
  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        const leading = autocomplete.mode === 'slash' && autocomplete.dispatchable === true
        const name = item.kind === 'command' && item.orcaOwned ? item.name : null
        if (leading && sideChat && isNativeChatSideChatCommand(name)) {
          // An unavailable row says why; picking it does nothing.
          if (sideChat.notReadyReason === null) {
            const draft = scope ? readNativeChatComposerDraft(scope) : null
            if (sideChat.auxiliary && scope && draft && /^\/\S*$/.test(draft.text.trim())) {
              if (!args.disabled && supportsSideChatDraft(scope, draft)) {
                open('', draft)
              } else {
                completeItem(item)
              }
            } else {
              completeItem(item)
            }
          }
        } else {
          pick(item)
        }
      },
    [args.disabled, autocomplete, completeItem, open, scope, sideChat]
  )
  return { matchesDraft, consume, interceptPick }
}
