// New bot's optional identity box: who the bot is and what it does. A typed one seeds SOUL.md the way a
// template's purpose does; Enter adds a line and ⌘↩ still creates.
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
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
      {/* The field's frame holds the padding, so the scrolling text shows exactly five whole lines. */}
      <div className="rounded-md border border-input px-3 py-2 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
        <ImeTextarea
          className="block h-[5lh] w-full resize-none border-0 bg-transparent p-0 text-sm leading-5 outline-none scrollbar-sleek placeholder:text-muted-foreground"
          rows={5}
          autoComplete="off"
          aria-label={t('bots.new.purposeLabel', 'Identity')}
          value={value}
          maxLength={PURPOSE_MAX_LENGTH}
          placeholder={t('bots.new.purposePlaceholder', 'Who it is and what it does')}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {value.length >= COUNTER_FROM ? (
        <p className="text-right text-xs text-muted-foreground tabular-nums">
          {value.length}/{PURPOSE_MAX_LENGTH}
        </p>
      ) : null}
    </div>
  )
}
