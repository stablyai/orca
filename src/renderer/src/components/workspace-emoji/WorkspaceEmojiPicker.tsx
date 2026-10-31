import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import { useAppStore } from '@/store/index'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { translate } from '@/i18n/i18n'

type WorkspaceEmojiPickerProps = {
  onPick: (emoji: string) => void
}

/** Lazy-loaded so the roughly 500KB emoji-picker chunk only ships when the picker opens. */
export function WorkspaceEmojiPicker({ onPick }: WorkspaceEmojiPickerProps): React.JSX.Element {
  const settingsTheme = useAppStore((state) => state.settings?.theme ?? 'system')
  const systemPrefersDark = useSystemPrefersDark()
  // Theme.AUTO only follows the OS setting, which can disagree with Orca's manual theme.
  const isDarkTheme = settingsTheme === 'dark' || (settingsTheme === 'system' && systemPrefersDark)

  return (
    <div className="repo-icon-emoji-picker overflow-hidden rounded-md">
      <EmojiPicker
        emojiStyle={EmojiStyle.NATIVE}
        height={340}
        width={320}
        lazyLoadEmojis
        onEmojiClick={(emojiData: EmojiClickData) => onPick(emojiData.emoji)}
        previewConfig={{ showPreview: false }}
        searchPlaceholder={translate(
          'auto.components.settings.RepositoryIconPicker.searchEmojiPlaceholder',
          'Search emoji'
        )}
        theme={isDarkTheme ? Theme.DARK : Theme.LIGHT}
      />
    </div>
  )
}
