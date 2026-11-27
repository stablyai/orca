// The line under a heading name field offering a name, taken by click or Tab; New group and Import use it.
import React from 'react'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'

/** Tab takes the suggestion; call from the name field's onKeyDown. True when it did. */
export function takeSuggestionOnTab(
  event: React.KeyboardEvent,
  suggestion: string | null,
  take: (name: string) => void
): boolean {
  if (event.key !== 'Tab' || event.shiftKey || !suggestion) {
    return false
  }
  event.preventDefault()
  take(suggestion)
  return true
}

/** Always 16 px tall, so the dialog does not jump when a suggestion comes and goes. */
export function BotNameSuggestion({
  suggestion,
  onTake,
  compact,
  children
}: {
  suggestion: string | null
  onTake: (name: string) => void
  compact?: boolean
  /** Shown instead when there is no suggestion. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={compact ? 'mt-1.5 flex h-4' : 'mt-1.5 flex h-4 justify-center'}>
      {suggestion ? (
        <button
          type="button"
          className={
            compact
              ? 'flex min-w-0 items-center text-xs leading-4 text-muted-foreground hover:text-foreground'
              : 'text-xs leading-4 text-muted-foreground hover:text-foreground'
          }
          onClick={() => onTake(suggestion)}
        >
          <span className={compact ? 'min-w-0 truncate' : undefined}>
            {t('bots.groups.useSuggestion', 'Use “{{name}}”', { name: suggestion })}
          </span>
          <ShortcutKeyCombo
            keys={[t('bots.groups.tabKey', 'Tab')]}
            className={compact ? 'ml-1 shrink-0' : 'ml-1'}
            size="compact"
          />
        </button>
      ) : (
        children
      )}
    </div>
  )
}
