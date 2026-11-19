// `/recap`: Orca's in-context recap for OpenCode chats; the host answers with a note in the chat.

import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import type { SlashCommandSuggestion } from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import type { NativeChatResumeCommand } from './use-native-chat-resume-command'

export function withNativeChatRecapCommand(
  commands: readonly SlashCommandSuggestion[]
): SlashCommandSuggestion[] {
  const recap: SlashCommandSuggestion = {
    name: 'recap',
    description: translate(
      'components.native-chat.recap.description',
      'Recap this chat with a quick summary'
    ),
    orcaOwned: true
  }
  return [recap, ...commands.filter((command) => command.name !== 'recap')]
}

/** In a structured OpenCode chat, `/recap` asks the host for a recap note; it never reaches the
 *  agent. */
export function useNativeChatRecapCommand(args: {
  structuredTransport: Pick<NativeChatStructuredComposerTransport, 'onError' | 'recap'> | undefined
  picker: Pick<NativeChatPickerState, 'isPickedSkill' | 'completeItem'> & {
    autocomplete: { mode: string; dispatchable?: boolean }
  }
  editor: {
    setDraft: (value: string) => void
    setCaret: Dispatch<SetStateAction<number>>
    setActiveSuggestion: Dispatch<SetStateAction<number>>
  }
  setNotice: (notice: string | null) => void
}): NativeChatResumeCommand {
  const { structuredTransport, setNotice } = args
  const { autocomplete, isPickedSkill, completeItem } = args.picker
  const { setDraft, setCaret, setActiveSuggestion } = args.editor
  const recap = structuredTransport?.recap
  const matchesDraft = useCallback(
    (draft: string) =>
      recap !== undefined && !isPickedSkill(draft) && /^\/recap\s*$/i.test(draft.trim()),
    [isPickedSkill, recap]
  )
  const consume = useCallback(
    (draft: string): boolean => {
      if (!recap || isPickedSkill(draft) || !/^\/recap\s*$/i.test(draft.trim())) {
        return false
      }
      setDraft('')
      setCaret(0)
      setActiveSuggestion(0)
      setNotice(null)
      void recap.run().then((refused) => {
        if (refused !== null) {
          structuredTransport?.onError(refused)
        }
      })
      return true
    },
    [isPickedSkill, recap, setActiveSuggestion, setCaret, setDraft, setNotice, structuredTransport]
  )
  // Completing the row just finishes `/recap`; only Send runs it.
  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        const leading = autocomplete.mode === 'slash' && autocomplete.dispatchable === true
        const name = item.kind === 'command' && item.orcaOwned ? item.name : null
        if (leading && recap && name === 'recap') {
          completeItem(item)
        } else {
          pick(item)
        }
      },
    [autocomplete, completeItem, recap]
  )
  return { matchesDraft, consume, interceptPick }
}
