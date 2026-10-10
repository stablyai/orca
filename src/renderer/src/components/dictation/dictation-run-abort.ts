import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type StopAudioCapture = (options?: { preserveBufferedAudio?: boolean }) => void

/**
 * Tears down a stale dictation run: buffer, playback-suppression lease, main
 * session, and capture. Shared by DictationController's start-path bail-outs
 * so the suppression release cannot drift from the stop call.
 */
export async function abortStaleDictationRun(args: {
  sessionId: string
  stopCapture: StopAudioCapture
  releasePlaybackSuppression: (sessionId: string) => Promise<void>
  discardBufferedAudio: () => void
  drainStoppedSession: (sessionId: string) => void
}): Promise<void> {
  const { sessionId, stopCapture, releasePlaybackSuppression } = args
  args.discardBufferedAudio()
  await releasePlaybackSuppression(sessionId)
  await window.api.speech.stopDictation(sessionId).catch(() => undefined)
  args.drainStoppedSession(sessionId)
  stopCapture()
}


/** The `onCaptureLost` toast + stop wiring shared by every dictation capture. */
export function handleDictationCaptureLost(args: {
  isStaleRun: boolean
  stopDictation: () => void
}): void {
  if (args.isStaleRun) {
    return
  }
  toast.message(
    translate('auto.components.dictation.DictationController.micDisconnected', 'Microphone disconnected. Dictation stopped.')
  )
  args.stopDictation()
}

/** Toast offering the Voice settings pane when no STT model is selected. */
export function showNoSpeechModelToast(): void {
  toast('No speech model selected. Download one in Settings > Voice.', {
    action: {
      label: translate('auto.components.dictation.DictationController.bb7f599ee7', 'Open Settings'),
      onClick: () => {
        useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
        useAppStore.getState().openSettingsPage()
      }
    }
  })
}


/** Toast shown when a dictation run ends with no focused insertion target. */
export function showNoFocusedTargetToast(): void {
  toast.message(
    translate(
      'auto.components.dictation.DictationController.7afff43472',
      'Dictation finished, but no text field was focused.'
    )
  )
}
