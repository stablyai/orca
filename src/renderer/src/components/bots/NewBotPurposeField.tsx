// New bot's optional identity box: who the bot is and what it does. A typed one seeds SOUL.md the way a
// template's purpose does; Enter adds a line and ⌘↩ still creates.
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'

/** BotProposalSeedSchema.purpose's limit. */
const PURPOSE_MAX_LENGTH = 200
const COUNTER_FROM = 160

export function NewBotPurposeField({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-1">
      <Textarea
        className="h-[calc(5lh+1rem)] resize-none"
        rows={5}
        autoComplete="off"
        aria-label={t('bots.new.purposeLabel', 'Identity')}
        value={value}
        maxLength={PURPOSE_MAX_LENGTH}
        placeholder={t('bots.new.purposePlaceholder', 'Who it is and what it does')}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.length >= COUNTER_FROM ? (
        <p className="text-right text-xs text-muted-foreground tabular-nums">
          {value.length}/{PURPOSE_MAX_LENGTH}
        </p>
      ) : null}
    </div>
  )
}
