import { translate } from '@/i18n/i18n'
import type { DictationState } from '../../../../shared/speech-types'

export function nativeChatVoiceStateLabel(
  phase: {
    preparing: boolean
    interrupting: boolean
    sending: boolean
    awaiting: boolean
    replyFinished: boolean
  },
  working: boolean,
  input: { state: DictationState; owned: boolean },
  playback: { speaking: boolean }
): string {
  return phase.preparing
    ? translate('stsLocal.preparing', 'Preparing local voice models (first download: 37 MB)…')
    : phase.interrupting && working
      ? translate('stsLive.interrupting', 'Stopping the reply…')
      : input.state === 'starting' && input.owned
        ? translate('stsVoice.starting', 'Starting microphone…')
        : phase.sending
          ? translate('stsVoice.sending', 'Sending…')
          : playback.speaking
            ? translate('stsLive.speakingListening', 'Speaking · listening for you')
            : working || (phase.awaiting && !phase.replyFinished)
              ? translate('stsLive.workingListening', 'Working · listening for you')
              : input.owned
                ? translate('stsVoice.listening', 'Listening')
                : translate('stsVoice.ready', 'Ready')
}
