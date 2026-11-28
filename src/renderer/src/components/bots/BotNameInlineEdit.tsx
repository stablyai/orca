// A bot's name, edited where it shows: a click turns it into a field in place; Enter or leaving saves, Escape cancels.
import { useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useBlurSaveOnUnmount } from '@/lib/text-input/focus/use-blur-save-on-unmount'
import { BOT_NAME_MAX_LENGTH, type Bot } from '../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'
import { BOT_EDIT_HINT } from './bot-edit-hint'
import { getWorktreeTitleRenameCommit } from '../sidebar/workspace-card/identity/WorktreeTitleInlineRename'

export function BotNameInlineEdit({
  bot,
  update,
  className
}: {
  bot: Bot
  /** Resolves null when the name is refused; the field then shows the saved name again. */
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
  /** The name's type: the field keeps it so editing doesn't move anything. */
  className: string
}): React.JSX.Element {
  const t = useTranslate()
  const [value, setValue] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Escape removes the field, whose blur must not then save it.
  const cancelled = useRef(false)
  // Enter and Escape leave the field from the keyboard, so focus goes back to the name.
  const refocus = useRef(false)

  const save = async (): Promise<void> => {
    if (value === null || saving || cancelled.current) {
      return
    }
    const commit = getWorktreeTitleRenameCommit(bot.name, value)
    if (commit.kind === 'save') {
      setSaving(true)
      await update({ name: commit.displayName })
      setSaving(false)
    }
    setValue(null)
  }
  useBlurSaveOnUnmount(() => value !== null && !cancelled.current, save)

  if (value === null) {
    return (
      <button
        ref={(node) => {
          if (!node || !refocus.current) {
            return
          }
          refocus.current = false
          // Unless the owner moved focus on while the name was saving.
          const active = document.activeElement
          if (!active || active === document.body) {
            node.focus()
          }
        }}
        type="button"
        onClick={() => {
          cancelled.current = false
          setValue(bot.name)
        }}
        aria-label={t('bots.settingsView.rename', 'Rename {{name}}', { name: bot.name })}
        className={cn(
          'group/edit flex max-w-full min-w-0 cursor-text items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
          className
        )}
      >
        <span className="min-w-0 truncate">{bot.name}</span>
        <Pencil
          aria-hidden
          className={cn('size-3 shrink-0 text-muted-foreground', BOT_EDIT_HINT)}
        />
      </button>
    )
  }
  return (
    // Drawn as a focused field; the negative margin pays for its padding, so the name doesn't move.
    <span
      className={cn(
        '-mx-1 grid max-w-[calc(100%+0.5rem)] min-w-0 rounded-sm bg-input/30 px-1 outline outline-1 outline-ring ring-[3px] ring-ring/50',
        className
      )}
    >
      <span aria-hidden className="invisible col-start-1 row-start-1 truncate whitespace-pre pr-5">
        {value || ' '}
      </span>
      <Input
        ref={(input) => {
          if (input && document.activeElement !== input) {
            input.focus()
            input.select()
          }
        }}
        value={value}
        maxLength={BOT_NAME_MAX_LENGTH}
        disabled={saving}
        spellCheck={false}
        autoComplete="off"
        style={{ font: 'inherit' }}
        aria-label={t('bots.settingsView.name', 'Bot name')}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (isImeCompositionKeyDown(event)) {
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            refocus.current = true
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            // The view takes Escape as Back; here it only cancels.
            event.preventDefault()
            event.stopPropagation()
            cancelled.current = true
            refocus.current = true
            setValue(null)
          }
        }}
        surface="inline"
        className="col-start-1 row-start-1"
      />
    </span>
  )
}
