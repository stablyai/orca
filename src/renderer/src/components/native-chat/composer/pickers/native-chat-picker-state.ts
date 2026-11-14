import type { Dispatch, SetStateAction } from 'react'
import type { ComposerAutocomplete } from '../../../../../../shared/native-chat/input/native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/native-chat-picker-items'
import type { NativeChatSendClassification } from '../../../../../../shared/native-chat/input/native-chat-slash-commands'
export type NativeChatPickerState = {
  autocomplete: ComposerAutocomplete
  listboxId: string
  retrySkills: () => void
  classifySend: (draft: string) => NativeChatSendClassification
  clearSkillOrigin: () => void
  /** The draft still leads with the skill the user picked from the menu. */
  isPickedSkill: (draft: string) => boolean
  completeItem: (item: NativeChatPickerItem) => void
  completeMention: (path: string) => void
  dismiss: (triggerKey: string) => void
  handleDraftOrCaretChange: (value: string, caret: number) => void
  /** Arrow-key highlight moves; a catalog refresh keeps the row they land on until the next edit. */
  navigateSuggestion: Dispatch<SetStateAction<number>>
}
