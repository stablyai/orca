// New bot's optional purpose, the name's quieter subtitle: a typed purpose seeds SOUL.md the way a template's does.
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { BARE_CAPTION_CLASS } from './new-bot-bare-fields'
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
    <div>
      <ImeTextarea
        className={BARE_CAPTION_CLASS}
        rows={1}
        autoComplete="off"
        aria-label={t('bots.new.purposeLabel', 'Purpose')}
        value={value}
        maxLength={PURPOSE_MAX_LENGTH}
        placeholder={t('bots.new.purposePlaceholder', 'Describe its job (optional)')}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.length >= COUNTER_FROM ? (
        <p className="text-center text-xs text-muted-foreground tabular-nums">
          {value.length}/{PURPOSE_MAX_LENGTH}
        </p>
      ) : null}
    </div>
  )
}
