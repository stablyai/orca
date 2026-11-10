import type { SpeechModelQuality } from '../../../../../shared/speech-model-quality'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat, uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'

// Intl formatter caches key on option identity, so these must be module constants.
const PERCENT_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 1 }
const DATE_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeZone: 'UTC' }
const SEGMENTS = [1, 2, 3, 4, 5] as const

export function VoiceSpeechModelQuality({
  quality
}: {
  quality: SpeechModelQuality
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  if (quality.kind === 'unsupported') {
    return (
      <span className="text-xs text-muted-foreground">
        {t('components.settings.voice.quality.unsupported', 'Doesn’t support your language')}
      </span>
    )
  }
  if (quality.kind === 'unmeasured') {
    return (
      <span className="text-xs text-muted-foreground">
        {t('components.settings.voice.quality.unmeasured', 'Not measured')}
      </span>
    )
  }
  const { tier, errorRate } = quality
  const word = [
    t('components.settings.voice.quality.poor', 'Poor'),
    t('components.settings.voice.quality.fair', 'Fair'),
    t('components.settings.voice.quality.good', 'Good'),
    t('components.settings.voice.quality.veryGood', 'Very good'),
    t('components.settings.voice.quality.excellent', 'Excellent')
  ][tier - 1]
  const percent = uiNumberFormat(PERCENT_FORMAT, intlLocale).format(errorRate.percent)
  const values = {
    percent,
    clips: errorRate.clips,
    date: uiDateTimeFormat(DATE_FORMAT, intlLocale).format(new Date(errorRate.measuredOn))
  }
  const rate =
    errorRate.metric === 'cer'
      ? t(
          'components.settings.voice.quality.characterErrorRate',
          '{{percent}}% character error rate',
          values
        )
      : t('components.settings.voice.quality.wordErrorRate', '{{percent}}% word error rate', values)
  const test =
    errorRate.test === 'librispeech'
      ? t(
          'components.settings.voice.quality.librispeech',
          'Test: LibriSpeech read speech, {{clips}} clips, measured {{date}}.',
          values
        )
      : t(
          'components.settings.voice.quality.fleurs',
          'Test: FLEURS read speech, {{clips}} clips, measured {{date}}.',
          values
        )
  const bench = t(
    'components.settings.voice.quality.bench',
    'Orca’s benchmark on a Mac with Apple silicon.'
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={t('components.settings.voice.quality.label', 'Quality: {{word}}', { word })}
          className="inline-flex items-center gap-2 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex gap-0.5" aria-hidden="true">
            {SEGMENTS.map((segment) => (
              <span
                key={segment}
                className={cn(
                  'h-1.5 w-2 rounded-full',
                  segment <= tier ? 'bg-foreground' : 'bg-muted-foreground/30'
                )}
              />
            ))}
          </span>
          {word}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-64">
        <p className="font-medium">{rate}</p>
        <p>
          {test} {bench}
        </p>
      </TooltipContent>
    </Tooltip>
  )
}
