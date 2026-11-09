import { useMemo, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { DictationIndicator } from './DictationIndicator'
import { publishDictationMeter, resetDictationMeter } from './dictation-meter-store'
import type { DictationFailureKind } from './dictation-toasts'
import type { DictationQueuedSendKind } from './use-dictation-queued-send'

function PaneWithPill({
  captureLive = true,
  failure = null,
  queued = null
}: {
  captureLive?: boolean
  failure?: DictationFailureKind | null
  queued?: DictationQueuedSendKind | null
}) {
  const [pane, setPane] = useState<HTMLElement | null>(null)
  const anchor = useMemo(
    () => (pane ? { element: pane, placement: 'over' as const } : null),
    [pane]
  )
  return (
    <div ref={setPane} className="relative h-28 w-full bg-background">
      {anchor ? (
        <DictationIndicator
          captureLive={captureLive}
          anchor={anchor}
          failure={failure}
          queued={queued}
        />
      ) : null}
    </div>
  )
}

export const listening = defineFixture({
  width: 520,
  store: { dictationState: 'listening' },
  setup: () => publishDictationMeter({ level: 0.5, isSpeaking: true, isClipping: false }),
  render: () => <PaneWithPill />
})

export const startingBeforeMic = defineFixture({
  width: 520,
  store: { dictationState: 'starting' },
  setup: resetDictationMeter,
  render: () => <PaneWithPill captureLive={false} />
})

export const liveText = defineFixture({
  width: 520,
  store: {
    dictationState: 'listening',
    partialTranscript:
      'It should go back to the page you came from. Check where returnTo gets dropped'
  },
  setup: () => publishDictationMeter({ level: 0.6, isSpeaking: true, isClipping: false }),
  render: () => <PaneWithPill />
})

export const tooLoud = defineFixture({
  width: 520,
  store: { dictationState: 'listening' },
  setup: () => publishDictationMeter({ level: 1, isSpeaking: true, isClipping: true }),
  render: () => <PaneWithPill />
})

export const finishing = defineFixture({
  width: 520,
  store: { dictationState: 'stopping' },
  setup: resetDictationMeter,
  render: () => <PaneWithPill />
})

export const transcribeFailed = defineFixture({
  width: 520,
  store: { dictationState: 'error' },
  render: () => <PaneWithPill failure="transcribe" />
})

export const modelFailed = defineFixture({
  width: 520,
  store: { dictationState: 'error' },
  render: () => <PaneWithPill failure="settings" />
})

export const queuedChatSend = defineFixture({
  width: 520,
  store: { dictationState: 'stopping' },
  setup: resetDictationMeter,
  render: () => <PaneWithPill queued="chat" />
})

export const queuedTerminalEnter = defineFixture({
  width: 520,
  store: { dictationState: 'stopping' },
  setup: resetDictationMeter,
  render: () => <PaneWithPill queued="terminal" />
})
