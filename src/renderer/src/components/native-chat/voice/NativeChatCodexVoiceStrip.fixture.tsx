import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatCodexVoiceStrip } from './NativeChatCodexVoiceStrip'
import { NativeChatCodexVoiceButton } from './NativeChatCodexVoiceButton'
import { NativeChatVoiceTranscriptLine } from './NativeChatVoiceTranscriptLine'
import type { CodexVoiceCallState } from './codex-voice-call'
import type { NativeChatCodexVoice } from './use-native-chat-codex-voice'

// Synthetic captions only; no recorded or real conversation.
const live: CodexVoiceCallState = {
  phase: 'live',
  muted: false,
  speaking: 'assistant',
  captions: [
    { id: 'rt-1', role: 'user', text: 'Should the cache be write-through or write-back?' },
    {
      id: 'rt-2',
      role: 'assistant',
      text: 'Write-through keeps reads fresh; write-back is faster.'
    }
  ],
  failure: null
}

function strip(call: CodexVoiceCallState, awaitingApproval = false): () => React.JSX.Element {
  return () => (
    <div className="native-chat-appearance p-4 pt-6">
      <NativeChatCodexVoiceStrip
        call={call}
        awaitingApproval={awaitingApproval}
        onMute={() => {}}
        onEnd={() => {}}
        onDismiss={() => {}}
      />
      <div className="mx-3 rounded-md border border-border p-3 text-sm text-muted-foreground sm:mx-4">
        Composer
      </div>
    </div>
  )
}

export const connecting = defineFixture({
  width: 720,
  render: strip({ ...live, phase: 'connecting', speaking: null, captions: [] })
})

export const speaking = defineFixture({ width: 720, render: strip(live) })

export const mutedAwaitingApproval = defineFixture({
  width: 720,
  render: strip({ ...live, muted: true, speaking: null }, true)
})

export const failed = defineFixture({
  width: 720,
  render: strip({
    ...live,
    phase: 'ended',
    speaking: null,
    failure: { kind: 'provider-error', message: 'synthetic provider message' }
  })
})

export const narrow = defineFixture({ width: 360, render: strip(live) })

function button(call: CodexVoiceCallState | null): () => React.JSX.Element {
  const voice: NativeChatCodexVoice = {
    availability: 'available',
    dictating: false,
    call,
    start: () => {},
    stop: () => {},
    setMuted: () => {},
    dismiss: () => {}
  }
  return () => (
    <div className="native-chat-appearance flex gap-2 p-4">
      <NativeChatCodexVoiceButton voice={voice} />
    </div>
  )
}

export const startButton = defineFixture({ width: 160, render: button(null) })

export const endButton = defineFixture({ width: 160, render: button(live) })

export const transcriptRows = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance flex flex-col gap-3 p-4">
      <NativeChatVoiceTranscriptLine
        speaker="user"
        text="Should the cache be write-through or write-back?"
      />
      <NativeChatVoiceTranscriptLine
        speaker="assistant"
        text="Write-through keeps reads fresh; write-back is faster but can lose writes."
      />
    </div>
  )
})
