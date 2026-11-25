import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

function describeSpeechModelDownloadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Strip Electron’s invoke wrapper so download errors show the underlying cause.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/** Starts a model download; a failure becomes a toast, and model states refresh either way. */
export function startSpeechModelDownload(modelId: string, refreshModelStates: () => void): void {
  void window.api.speech
    .downloadModel(modelId)
    .catch((error: unknown) =>
      toast.error(
        translate('auto.components.settings.VoicePane.cfde55c7b0', 'Failed to download model.'),
        // Include the raw cause because it is the diagnosable failure users can report.
        { description: describeSpeechModelDownloadError(error) }
      )
    )
    .finally(refreshModelStates)
}

export function cancelSpeechModelDownload(modelId: string, refreshModelStates: () => void): void {
  void window.api.speech.cancelDownload(modelId).finally(refreshModelStates)
}
