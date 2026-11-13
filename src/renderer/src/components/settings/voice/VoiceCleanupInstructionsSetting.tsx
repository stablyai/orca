import { useId, useState } from 'react'
import { BUILT_IN_DICTATION_CLEANUP_INSTRUCTIONS } from '../../../../../shared/dictation-cleanup'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { Textarea } from '../../ui/textarea'
import { SettingsRow } from '../form-controls/SettingsFormControls'

/** Collapsed to a summary; Edit opens the built-in or saved text to change in place. */
export function VoiceCleanupInstructionsSetting({
  instructions,
  onSave
}: {
  /** Absent: the built-in instructions. */
  instructions: string | undefined
  onSave: (instructions: string | undefined) => void
}): React.JSX.Element {
  const t = useTranslate()
  const fieldId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const custom = instructions?.trim() ? instructions : undefined
  const label = t('components.settings.voice.cleanup.instructions.label', 'Instructions')
  if (draft === null) {
    return (
      <SettingsRow
        label={label}
        description={
          custom
            ? t('components.settings.voice.cleanup.instructions.custom', 'Your own instructions.')
            : t(
                'components.settings.voice.cleanup.instructions.builtIn',
                'Built-in: fix punctuation, numbers and corrections. Keep my wording.'
              )
        }
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft(custom ?? BUILT_IN_DICTATION_CLEANUP_INSTRUCTIONS)}
          >
            {t('components.settings.voice.cleanup.instructions.edit', 'Edit')}
          </Button>
        }
      />
    )
  }
  const save = (): void => {
    const text = draft.trim()
    onSave(text && text !== BUILT_IN_DICTATION_CLEANUP_INSTRUCTIONS ? text : undefined)
    setDraft(null)
  }
  return (
    <div data-settings-row="" className="space-y-2 py-3">
      <div className="space-y-1">
        <Label htmlFor={fieldId}>{label}</Label>
        <p className="text-xs text-muted-foreground">
          {t(
            'components.settings.voice.cleanup.instructions.emptyHint',
            'Leave empty for the built-in ones.'
          )}
        </p>
      </div>
      <Textarea
        id={fieldId}
        value={draft}
        rows={4}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDraft(BUILT_IN_DICTATION_CLEANUP_INSTRUCTIONS)}
        >
          {t('components.settings.voice.cleanup.instructions.reset', 'Reset')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
          {t('components.settings.voice.cleanup.instructions.cancel', 'Cancel')}
        </Button>
        <Button size="sm" onClick={save}>
          {t('components.settings.voice.cleanup.instructions.save', 'Save')}
        </Button>
      </div>
    </div>
  )
}
