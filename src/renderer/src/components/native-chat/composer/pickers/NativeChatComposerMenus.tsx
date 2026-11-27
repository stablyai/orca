import type { ComposerAutocomplete } from '../../../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import { NativeChatMentionMenu, NativeChatPickerMenu } from './NativeChatAutocompleteMenus'
import type { NativeChatMentionFiles } from './use-native-chat-mention-files'

/** The open `/` or `@` list above a composer. */
export function NativeChatComposerMenus({
  autocomplete,
  mention,
  activeIndex,
  listboxId,
  onChooseItem,
  onRetrySkills,
  onChooseMention,
  onHoverMention
}: {
  autocomplete: ComposerAutocomplete
  mention: NativeChatMentionFiles
  activeIndex: number
  listboxId: string
  onChooseItem: (item: NativeChatPickerItem) => void
  onRetrySkills: () => void
  onChooseMention: (path: string) => void
  onHoverMention?: (index: number) => void
}): React.JSX.Element | null {
  if (autocomplete.mode === 'slash') {
    return (
      <NativeChatPickerMenu
        autocomplete={autocomplete}
        activeIndex={activeIndex}
        listboxId={listboxId}
        onChoose={onChooseItem}
        onRetry={onRetrySkills}
      />
    )
  }
  if (autocomplete.mode === 'mention') {
    return (
      <NativeChatMentionMenu
        mention={mention}
        activeIndex={activeIndex}
        listboxId={listboxId}
        onChoose={onChooseMention}
        onHover={onHoverMention}
      />
    )
  }
  return null
}
