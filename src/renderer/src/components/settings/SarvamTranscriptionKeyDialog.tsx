import { CloudApiKeyDialog } from './CloudApiKeyDialog'
import { translate } from '@/i18n/i18n'

type SarvamTranscriptionKeyDialogProps = {
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function SarvamTranscriptionKeyDialog({
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: SarvamTranscriptionKeyDialogProps): React.JSX.Element {
  return (
    <CloudApiKeyDialog
      open={open}
      configured={configured}
      apiKeyDraft={apiKeyDraft}
      pending={pending}
      onOpenChange={onOpenChange}
      onApiKeyDraftChange={onApiKeyDraftChange}
      onSave={onSave}
      onClear={onClear}
      inputId="sarvam-speech-api-key"
      title={translate(
        'auto.components.settings.SarvamTranscriptionKeyDialog.title',
        'Sarvam Transcription'
      )}
      description={translate(
        'auto.components.settings.SarvamTranscriptionKeyDialog.description',
        'Audio streams to Sarvam only when a Sarvam speech model is selected. Supports 23 Indian languages and English with auto-detect.'
      )}
      apiKeyLabel={translate(
        'auto.components.settings.SarvamTranscriptionKeyDialog.apiKey',
        'API Key'
      )}
      placeholder={
        configured
          ? translate(
              'auto.components.settings.SarvamTranscriptionKeyDialog.placeholderConfigured',
              'API key configured'
            )
          : translate(
              'auto.components.settings.SarvamTranscriptionKeyDialog.placeholder',
              'Sarvam API subscription key'
            )
      }
      storageNote={translate(
        'auto.components.settings.SarvamTranscriptionKeyDialog.storage',
        'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
      )}
      clearLabel={translate(
        'auto.components.settings.SarvamTranscriptionKeyDialog.clear',
        'Clear Key'
      )}
      saveLabel={translate(
        'auto.components.settings.SarvamTranscriptionKeyDialog.save',
        'Save Key'
      )}
    />
  )
}
