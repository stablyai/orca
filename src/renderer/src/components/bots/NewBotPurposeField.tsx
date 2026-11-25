// New bot's optional identity box: who the bot is and what it does. A typed one seeds SOUL.md the way a
// template's purpose does; Enter adds a line and ⌘↩ still creates.
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BOT_PURPOSE_MAX_LENGTH } from '../../../../shared/bots/bot-proposal'
// The count shows once the text nears the limit.
const COUNTER_FROM = Math.floor(BOT_PURPOSE_MAX_LENGTH * 0.8)

export function NewBotPurposeField({
  value,
  prefilled,
  tooLong,
  sentLength,
  onChange
}: {
  value: string
  /** A template's text: no counter until it is edited, since it is sent as the template wrote it. */
  prefilled?: string
  tooLong: boolean
  /** How long the purpose Create sends is; a cleared box sends a proposal's own. */
  sentLength: number
  onChange: (value: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const counterId = useId()
  return (
    <div className="space-y-1">
      {/* The field's frame holds the padding, so the scrolling text shows whole lines. */}
      <div className="rounded-md border border-input px-3 py-2 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 has-aria-invalid:border-destructive has-aria-invalid:ring-destructive/20 dark:bg-input/30 dark:has-aria-invalid:ring-destructive/40">
        <ImeTextarea
          className={cn(
            'block w-full resize-none border-0 bg-transparent p-0 text-sm leading-5 outline-none scrollbar-sleek placeholder:text-muted-foreground',
            // A template's text shows whole, up to seven lines, before it scrolls.
            prefilled === undefined ? 'h-[5lh]' : 'max-h-[7lh] min-h-[5lh] [field-sizing:content]'
          )}
          rows={5}
          autoComplete="off"
          aria-label={t('bots.new.purposeLabel', 'Identity')}
          aria-invalid={tooLong || undefined}
          aria-describedby={tooLong ? counterId : undefined}
          value={value}
          maxLength={BOT_PURPOSE_MAX_LENGTH}
          placeholder={t('bots.new.purposePlaceholder', 'Who it is and what it does')}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {tooLong || (value.length >= COUNTER_FROM && value !== prefilled) ? (
        <p
          id={counterId}
          role={tooLong ? 'alert' : undefined}
          className={cn(
            'text-xs tabular-nums',
            tooLong ? 'text-destructive' : 'text-right text-muted-foreground'
          )}
        >
          {tooLong ? `${t('bots.new.validation.identityTooLong', 'Too long')} · ` : null}
          {tooLong ? sentLength : value.length}/{BOT_PURPOSE_MAX_LENGTH}
        </p>
      ) : null}
    </div>
  )
}
