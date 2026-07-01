import { CloudApiKeyDialog } from './CloudApiKeyDialog'
import { translate } from '@/i18n/i18n'

type OpenAiTranscriptionKeyDialogProps = {
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function OpenAiTranscriptionKeyDialog({
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: OpenAiTranscriptionKeyDialogProps): React.JSX.Element {
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
      inputId="openai-speech-api-key"
      title={translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.439e91879e',
        'OpenAI Transcription'
      )}
      description={translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.07ed3e512e',
        'Audio is sent to OpenAI only when an OpenAI speech model is selected.'
      )}
      apiKeyLabel={translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.16015322f9',
        'API Key'
      )}
      placeholder={
        configured
          ? translate(
              'auto.components.settings.OpenAiTranscriptionKeyDialog.2f797018f0',
              'API key configured'
            )
          : translate('auto.components.settings.OpenAiTranscriptionKeyDialog.c3380e4ca5', 'sk-...')
      }
      storageNote={translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.d246b2bdb3',
        'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
      )}
      clearLabel={translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.07b26f2742',
        'Clear Key'
      )}
      saveLabel={translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.fa83512e48',
        'Save Key'
      )}
    />
  )
}
