import { toast } from 'sonner'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import type { RepoIcon } from '../../../../../../shared/repo-icon'
import { sanitizeRepoIcon } from '../../../../../../shared/repo-icon'
import { useAppStore } from '@/store/index'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { translate } from '@/i18n/i18n'

type RepositoryIconEmojiPickerProps = {
  selectedEmoji: string
  onSetIcon: (repoIcon: RepoIcon | null) => void
}

/** Lazy-load the roughly 500KB emoji-picker chunk only when the Emoji tab renders. */
export function RepositoryIconEmojiPicker({
  selectedEmoji,
  onSetIcon
}: RepositoryIconEmojiPickerProps): React.JSX.Element {
  const settingsTheme = useAppStore((state) => state.settings?.theme ?? 'system')
  const systemPrefersDark = useSystemPrefersDark()
  // Theme.AUTO only follows the OS setting, which can disagree with Orca's manual theme.
  const isDarkTheme = settingsTheme === 'dark' || (settingsTheme === 'system' && systemPrefersDark)

  const handleEmojiClick = (emojiData: EmojiClickData): void => {
    // ZWJ/skin-tone sequences can exceed sanitizeRepoIcon’s UTF-16 cap.
    const repoIcon = sanitizeRepoIcon({ type: 'emoji', emoji: emojiData.emoji })
    if (!repoIcon) {
      toast.error(
        translate(
          'auto.components.settings.RepositoryIconPicker.emojiTooLongForRepoIcon',
          "This emoji can't be used as a repo icon."
        )
      )
      return
    }
    onSetIcon(repoIcon)
  }

  return (
    <>
      <div className="repo-icon-emoji-picker overflow-hidden rounded-md border border-border">
        <EmojiPicker
          // Inline emoji tabs can mount with Settings; autofocus would steal the search field.
          autoFocusSearch={false}
          emojiStyle={EmojiStyle.NATIVE}
          height={340}
          width="100%"
          lazyLoadEmojis
          onEmojiClick={handleEmojiClick}
          previewConfig={{ showPreview: true }}
          searchPlaceholder={translate(
            'auto.components.settings.RepositoryIconPicker.searchEmojiPlaceholder',
            'Search emoji'
          )}
          theme={isDarkTheme ? Theme.DARK : Theme.LIGHT}
        />
      </div>
      {selectedEmoji ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryIconPicker.currentEmojiSelection',
            'Current: {{value0}}',
            { value0: selectedEmoji }
          )}
        </p>
      ) : null}
    </>
  )
}
