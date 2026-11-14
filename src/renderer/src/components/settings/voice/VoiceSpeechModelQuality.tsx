import type { SpeechModelQuality } from '../../../../../shared/speech-model-quality'
import { useTranslate } from '@/i18n/use-translate'

export function VoiceSpeechModelQuality({
  quality
}: {
  quality: SpeechModelQuality
}): React.JSX.Element {
  const t = useTranslate()
  if (quality.kind !== 'rated') {
    return (
      <span className="block leading-snug text-muted-foreground">
        {quality.kind === 'unsupported'
          ? t('components.settings.voice.quality.unsupported', 'Doesn’t support your language')
          : t('components.settings.voice.quality.unmeasured', 'Not measured')}
      </span>
    )
  }
  const word = [
    t('components.settings.voice.quality.poor', 'Poor'),
    t('components.settings.voice.quality.fair', 'Fair'),
    t('components.settings.voice.quality.good', 'Good'),
    t('components.settings.voice.quality.veryGood', 'Very good'),
    t('components.settings.voice.quality.excellent', 'Excellent')
  ][quality.tier - 1]
  return <span>{word}</span>
}
