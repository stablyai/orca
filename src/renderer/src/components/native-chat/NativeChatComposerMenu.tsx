import { memo, useEffect, useRef } from 'react'
import { History } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { ComposerAutocomplete } from '../../../../shared/native-chat/input/native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import {
  NativeChatMentionMenu,
  NativeChatPickerMenu,
  PickerListbox,
  PickerOptionButton,
  PickerStatus
} from './NativeChatAutocompleteMenus'
import type { NativeChatSentPrompt } from './native-chat-sent-prompt-history'
import type { NativeChatMentionFiles } from './use-native-chat-mention-files'
import type { NativeChatComposerPromptSearch } from './use-native-chat-composer-prompt-search'

type NativeChatComposerMenuSources = {
  autocomplete: ComposerAutocomplete
  mentionFiles: NativeChatMentionFiles
  activeSuggestion: number
  /** An open Ctrl+R search takes the menu's place over any autocomplete. */
  promptSearch?: NativeChatComposerPromptSearch | undefined
}

/** What the composer's combobox attributes describe: whether a menu is open and its active option. */
export function nativeChatComposerMenuState({
  autocomplete,
  mentionFiles,
  activeSuggestion,
  promptSearch
}: NativeChatComposerMenuSources): { open: boolean; optionCount: number; activeOption: number } {
  const matches = promptSearch?.matches
  if (matches) {
    return { open: true, optionCount: matches.length, activeOption: promptSearch.activeIndex }
  }
  const optionCount =
    autocomplete.mode === 'slash'
      ? autocomplete.items.length
      : autocomplete.mode === 'mention'
        ? mentionFiles.files.length
        : 0
  return { open: autocomplete.mode !== 'none', optionCount, activeOption: activeSuggestion }
}

export function NativeChatComposerMenu({
  autocomplete,
  mentionFiles,
  activeSuggestion,
  promptSearch,
  listboxId,
  onChoosePickerItem,
  onRetrySkills,
  onChooseMentionFile
}: NativeChatComposerMenuSources & {
  listboxId: string
  onChoosePickerItem: (item: NativeChatPickerItem) => void
  onRetrySkills: () => void
  onChooseMentionFile: (path: string) => void
}): React.JSX.Element | null {
  if (promptSearch?.matches) {
    return (
      <NativeChatPromptSearchMenu
        matches={promptSearch.matches}
        activeIndex={promptSearch.activeIndex}
        listboxId={listboxId}
        onChoose={promptSearch.choose}
      />
    )
  }
  if (autocomplete.mode === 'slash') {
    return (
      <NativeChatPickerMenu
        autocomplete={autocomplete}
        activeIndex={activeSuggestion}
        listboxId={listboxId}
        onChoose={onChoosePickerItem}
        onRetry={onRetrySkills}
      />
    )
  }
  if (autocomplete.mode === 'mention') {
    return (
      <NativeChatMentionMenu
        mention={mentionFiles}
        activeIndex={activeSuggestion}
        listboxId={listboxId}
        onChoose={onChooseMentionFile}
      />
    )
  }
  return null
}

const NativeChatPromptSearchMenu = memo(function NativeChatPromptSearchMenu({
  matches,
  activeIndex,
  listboxId,
  onChoose
}: {
  matches: readonly NativeChatSentPrompt[]
  activeIndex: number
  listboxId: string
  onChoose: (prompt: string) => void
}): React.JSX.Element {
  useUiLanguageRevision()
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, matches])

  const statusText =
    matches.length > 0
      ? null
      : translate('components.native-chat.composer.noMatchingPrompts', 'No matching prompts')

  return (
    <PickerListbox id={listboxId}>
      <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate('components.native-chat.composer.sentPrompts', 'Sent prompts')}
      </div>
      {matches.map((match, index) => (
        <PickerOptionButton
          key={match.id}
          id={`${listboxId}-option-${index}`}
          selected={index === activeIndex}
          activeItemRef={activeItemRef}
          onChoose={() => onChoose(match.prompt)}
        >
          <History className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{match.prompt}</span>
        </PickerOptionButton>
      ))}
      {statusText ? <PickerStatus>{statusText}</PickerStatus> : null}
      <div aria-live="polite" className="sr-only">
        {statusText ?? ''}
      </div>
    </PickerListbox>
  )
})
