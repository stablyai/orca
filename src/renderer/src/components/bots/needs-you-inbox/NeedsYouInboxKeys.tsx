// The inbox's keys, along its foot: what each one does while the list has focus.
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'

export function NeedsYouInboxKeys(): React.JSX.Element {
  const t = useTranslate()
  const keys: [string[], string][] = [
    [['J', 'K'], t('bots.needsYouInbox.keys.move', 'Move')],
    [['1–9'], t('bots.needsYouInbox.keys.answer', 'Answer')],
    [['I'], t('bots.needsYouInbox.keys.reply', 'Reply')],
    [['↵'], t('bots.needsYouInbox.keys.open', 'Open on its bot')],
    [['E'], t('bots.needsYouInbox.keys.done', 'Done')],
    [['S'], t('bots.needsYouInbox.keys.snooze', 'Snooze')],
    [['G'], t('bots.needsYouInbox.keys.group', 'Group by bot')]
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-2 text-xs text-muted-foreground">
      {keys.map(([combo, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          <ShortcutKeyCombo keys={combo} size="compact" separatorClassName="hidden" />
          {label}
        </span>
      ))}
    </div>
  )
}
