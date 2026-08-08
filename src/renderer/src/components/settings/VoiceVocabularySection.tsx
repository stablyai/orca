import { useEffect, useState } from 'react'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { normalizeSpeechHotwords } from '../../../../shared/speech-hotwords'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

const EMPTY_VOCABULARY: string[] = []

export function parseCustomVocabularyDraft(value: string): string[] {
  return normalizeSpeechHotwords(value.split(/[,，\n]/u))
}

type VoiceVocabularySectionProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

function areTermsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((term, index) => term === right[index])
}

export function VoiceVocabularySection({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceVocabularySectionProps): React.JSX.Element {
  const vocabulary = voiceSettings.customVocabulary ?? EMPTY_VOCABULARY
  const [draft, setDraft] = useState(() => vocabulary.join('\n'))

  useEffect(() => {
    setDraft(vocabulary.join('\n'))
  }, [vocabulary])

  const saveDraft = (): void => {
    const nextVocabulary = parseCustomVocabularyDraft(draft)
    setDraft(nextVocabulary.join('\n'))
    if (!areTermsEqual(vocabulary, nextVocabulary)) {
      onUpdateVoiceSettings({ customVocabulary: nextVocabulary })
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor="voice-custom-vocabulary">
          {translate('auto.components.settings.VoiceVocabularySection.label', 'Custom Vocabulary')}
        </Label>
        <p
          id="voice-custom-vocabulary-description"
          className="max-w-[34rem] text-xs text-muted-foreground"
        >
          {translate(
            'auto.components.settings.VoiceVocabularySection.description',
            'Add names, technical terms, and mixed-language phrases. Supported local models use them to improve recognition.'
          )}
        </p>
      </div>
      <textarea
        id="voice-custom-vocabulary"
        aria-describedby="voice-custom-vocabulary-description"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={saveDraft}
        rows={4}
        spellCheck={false}
        placeholder={translate(
          'auto.components.settings.VoiceVocabularySection.placeholder',
          'Orca\nQwen3-ASR\nPowerShell'
        )}
        className="min-h-24 w-64 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
      />
    </div>
  )
}
