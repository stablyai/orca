import type { VoiceSettings } from '../../../../shared/speech-types'
import { translate } from '@/i18n/i18n'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export function NativeChatVoiceSettings({
  voice,
  transport,
  working
}: {
  voice?: VoiceSettings
  transport: Pick<NativeChatStructuredComposerTransport, 'optionsSurface' | 'optionSnapshot'>
  working: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-1 border-b border-border px-3 py-2">
      <NativeChatSessionOptionPickers
        surface={transport.optionsSurface}
        snapshot={transport.optionSnapshot}
        isWorking={working}
      />
      <p className="text-xs text-chat-foreground-faint">
        {translate('stsLive.inputProvider', 'Speech recognition')}:{' '}
        {voice?.sttModel === 'elevenlabs-scribe-v2-realtime'
          ? translate('stsLive.elevenLabsStt', 'ElevenLabs Scribe')
          : voice?.sttModel || '—'}
        <br />
        {translate('elevenLabsVoice.output', 'Response voice (TTS)')}:{' '}
        {voice?.ttsProvider === 'elevenlabs'
          ? translate('elevenLabsVoice.cloud', 'ElevenLabs · account usage')
          : translate('elevenLabsVoice.local', 'Local system voice · free')}
      </p>
      <p className="text-xs text-chat-foreground-faint">
        {translate(
          'stsHistory.modelHint',
          'Voice uses this chat’s model and permissions. Change the model above when needed.'
        )}
      </p>
    </div>
  )
}
