import { toast } from 'sonner'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import type { RepoIcon } from '../../../../../../shared/repository/appearance/repo-icon'
import { sanitizeRepoIcon } from '../../../../../../shared/repository/appearance/repo-icon'
import { useDocumentDarkTheme } from '@/hooks/theme/use-document-dark-theme'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

type RepositoryIconEmojiPickerProps = {
  selectedEmoji: string
  onSetIcon: (repoIcon: RepoIcon | null) => void
  /** Hover-card layout: shorter, no preview strip or "Current" line. */
  compact?: boolean
}

/** Lazy-load the roughly 500KB emoji-picker chunk only when the Emoji tab renders. */
export function RepositoryIconEmojiPicker({
  selectedEmoji,
  onSetIcon,
  compact = false
}: RepositoryIconEmojiPickerProps): React.JSX.Element {
  const t = useTranslate()
  // Theme.AUTO only follows the OS setting, which can disagree with Orca's painted theme.
  const isDarkTheme = useDocumentDarkTheme()

  const handleEmojiClick = (emojiData: EmojiClickData): void => {
    // ZWJ/skin-tone sequences can exceed sanitizeRepoIcon’s UTF-16 cap.
    const repoIcon = sanitizeRepoIcon({ type: 'emoji', emoji: emojiData.emoji })
    if (!repoIcon) {
      toast.error(
        t(
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
      <div
        className={cn(
          'repo-icon-emoji-picker overflow-hidden rounded-md',
          !compact && 'border border-border'
        )}
        data-compact={compact || undefined}
      >
        <EmojiPicker
          // Inline emoji tabs can mount with Settings; autofocus would steal the search field.
          autoFocusSearch={false}
          emojiStyle={EmojiStyle.NATIVE}
          height={compact ? 220 : 340}
          skinTonesDisabled={compact}
          width="100%"
          lazyLoadEmojis
          onEmojiClick={handleEmojiClick}
          previewConfig={{ showPreview: !compact }}
          searchPlaceholder={t(
            'auto.components.settings.RepositoryIconPicker.searchEmojiPlaceholder',
            'Search emoji'
          )}
          theme={isDarkTheme ? Theme.DARK : Theme.LIGHT}
        />
      </div>
      {selectedEmoji && !compact ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t(
            'auto.components.settings.RepositoryIconPicker.currentEmojiSelection',
            'Current: {{value0}}',
            { value0: selectedEmoji }
          )}
        </p>
      ) : null}
    </>
  )
}
