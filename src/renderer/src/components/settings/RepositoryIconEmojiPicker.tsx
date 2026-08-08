import { toast } from 'sonner'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { sanitizeRepoIcon } from '../../../../shared/repo-icon'
import { useAppStore } from '../../store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { translate } from '@/i18n/i18n'

type RepositoryIconEmojiPickerProps = {
  selectedEmoji: string
  onSetIcon: (repoIcon: RepoIcon | null) => void
}

/**
 * Full native emoji picker for the repo icon "Emoji" tab. Kept in its own
 * module (lazy-loaded by RepositoryIconTabs) so emoji-picker-react's ~500KB
 * chunk only loads once this tab actually renders.
 */
export function RepositoryIconEmojiPicker({
  selectedEmoji,
  onSetIcon
}: RepositoryIconEmojiPickerProps): React.JSX.Element {
  // Minimal selector: only the theme string is needed; default to system before settings load.
  const settingsTheme = useAppStore((state) => state.settings?.theme ?? 'system')
  const systemPrefersDark = useSystemPrefersDark()
  // Theme.AUTO only follows the OS setting, which can disagree with Orca's manual theme.
  const isDarkTheme = settingsTheme === 'dark' || (settingsTheme === 'system' && systemPrefersDark)

  /** Saves the picked emoji, rejecting anything over sanitizeRepoIcon's 16-char cap. */
  const handleEmojiClick = (emojiData: EmojiClickData): void => {
    // ZWJ/skin-tone sequences can exceed the 16-char cap even without skinTonesDisabled.
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
          // Off by default here: this picker is inline, and can mount with the panel
          // (emoji repos open on this tab), so autofocus would steal the settings search.
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
