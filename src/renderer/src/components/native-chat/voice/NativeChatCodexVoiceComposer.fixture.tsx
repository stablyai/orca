import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatComposerActions } from '../composer/controls/NativeChatComposerActions'
import { NativeChatCodexVoiceStrip } from './NativeChatCodexVoiceStrip'
import {
  NativeChatCodexVoiceContext,
  type NativeChatCodexVoice
} from './use-native-chat-codex-voice'
import type { CodexVoiceCallState } from './codex-voice-call'

// Before/after pair for the PR: the same composer controls, viewport and theme. Synthetic text only.
const liveCall: CodexVoiceCallState = {
  phase: 'live',
  muted: false,
  speaking: 'assistant',
  captions: [{ id: 'rt-1', role: 'assistant', text: 'Write-through keeps reads fresh.' }],
  failure: null
}

function composer(voice: NativeChatCodexVoice | null): () => React.JSX.Element {
  return () => (
    <div className="native-chat-appearance p-4 pt-8">
      <NativeChatCodexVoiceContext value={voice}>
        {voice?.call ? (
          <NativeChatCodexVoiceStrip
            call={voice.call}
            awaitingApproval={false}
            onMute={() => {}}
            onEnd={() => {}}
            onDismiss={() => {}}
          />
        ) : null}
        <div className="mx-3 rounded-md border border-border px-3 py-2 sm:mx-4">
          <p className="px-2 py-1 text-sm text-chat-foreground-faint">Ask Codex anything</p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <NativeChatComposerActions
              attachDisabled={false}
              dictationDisabled={false}
              sendDisabled
              isWorking={false}
              isDictating={false}
              isDictationHoldMode={false}
              onAttach={() => {}}
              onDictationToggle={() => {}}
              onDictationHoldStart={() => {}}
              onDictationHoldEnd={() => {}}
              onSend={() => {}}
              sessionOptionsSurface={null}
              sessionOptionsSnapshot={[]}
              agent="codex"
            />
          </div>
        </div>
      </NativeChatCodexVoiceContext>
    </div>
  )
}

const voice = (call: CodexVoiceCallState | null): NativeChatCodexVoice => ({
  availability: 'available',
  dictating: false,
  call,
  start: () => {},
  stop: () => {},
  setMuted: () => {},
  dismiss: () => {}
})

/** Today's Codex composer: dictation only. */
export const before = defineFixture({ width: 720, render: composer(null) })

/** The voice control beside dictation, idle. */
export const afterIdle = defineFixture({ width: 720, render: composer(voice(null)) })

/** A live call: the strip on the composer, dictation held while voice owns the microphone. */
export const afterLive = defineFixture({ width: 720, render: composer(voice(liveCall)) })
