import { useEffect, useState } from 'react'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { normalizeSpeechHotwords } from '../../../../shared/speech-hotwords'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

export function parseCustomVocabularyDraft(value: string): string[] {
  return normalizeSpeechHotwords(value.split(/,|\n/))
}

type VoiceVocabularySectionProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceVocabularySection({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceVocabularySectionProps): React.JSX.Element {
  const [draft, setDraft] = useState(() => voiceSettings.customVocabulary.join('\n'))

  useEffect(() => {
    setDraft(voiceSettings.customVocabulary.join('\n'))
  }, [voiceSettings.customVocabulary])

  const saveDraft = (): void => {
    const nextVocabulary = parseCustomVocabularyDraft(draft)
    setDraft(nextVocabulary.join('\n'))
    onUpdateVoiceSettings({ customVocabulary: nextVocabulary })
  }

  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor="voice-custom-vocabulary">
          {translate(
            'auto.components.settings.VoicePane.customVocabulary.label',
            'Custom Vocabulary'
          )}
        </Label>
        <p className="max-w-[34rem] text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.VoicePane.customVocabulary.description',
            'Add names, product terms, and project jargon to bias local speech recognition.'
          )}
        </p>
      </div>
      <textarea
        id="voice-custom-vocabulary"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={saveDraft}
        rows={4}
        spellCheck={false}
        placeholder={translate(
          'auto.components.settings.VoicePane.customVocabulary.placeholder',
          'Orca\nWolfgang'
        )}
        className="min-h-24 w-64 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
      />
    </div>
  )
}
