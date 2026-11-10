import { useMemo, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { DictationIndicator } from './DictationIndicator'
import { publishDictationMeter, resetDictationMeter } from './dictation-meter-store'
import type { DictationFailureKind } from './dictation-toasts'
import type { SpeechModelUpdateTarget } from './speech-model-update-target'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import type {
  DictationAutoSendCountdown,
  DictationQueuedSendKind
} from './use-dictation-queued-send'
import type { DictationCleanupNotice } from './use-dictation-cleanup'

function PaneWithPill({
  captureLive = true,
  failure = null,
  queued = null,
  autoSend = null,
  setup = null,
  cleaning = false,
  notice = null
}: {
  captureLive?: boolean
  failure?: DictationFailureKind | null
  queued?: DictationQueuedSendKind | null
  autoSend?: DictationAutoSendCountdown | null
  setup?: SpeechModelUpdateTarget | null
  cleaning?: boolean
  notice?: DictationCleanupNotice['kind'] | null
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
          cleanup={{
            cleaning,
            notice: notice ? { kind: notice, anchor } : null,
            dismissNotice: () => {}
          }}
          autoSend={autoSend}
          setup={setup}
          onSetupClose={() => {}}
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
    liveText: {
      committed: 'It should go back to the page you came from.',
      tentative: 'Check where returnTo gets dropped',
      speechPending: false
    }
  },
  setup: () => publishDictationMeter({ level: 0.6, isSpeaking: true, isClipping: false }),
  render: () => <PaneWithPill />
})

export const committedText = defineFixture({
  width: 520,
  store: {
    dictationState: 'listening',
    liveText: {
      committed: 'It should go back to the page you came from. Check where returnTo gets dropped.',
      tentative: '',
      speechPending: false
    }
  },
  setup: () => publishDictationMeter({ level: 0.2, isSpeaking: false, isClipping: false }),
  render: () => <PaneWithPill />
})

export const pendingSpeech = defineFixture({
  width: 520,
  store: {
    dictationState: 'listening',
    liveText: {
      committed: 'It should go back to the page you came from.',
      tentative: '',
      speechPending: true
    }
  },
  setup: () => publishDictationMeter({ level: 0.6, isSpeaking: true, isClipping: false }),
  render: () => <PaneWithPill />
})

export const pendingFirstWords = defineFixture({
  width: 520,
  store: {
    dictationState: 'listening',
    liveText: { committed: '', tentative: '', speechPending: true }
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

export const cleaningUp = defineFixture({
  width: 520,
  store: {
    dictationState: 'stopping',
    liveText: {
      committed: 'move the retry into the worker at four scratch that at five',
      tentative: '',
      speechPending: false
    }
  },
  setup: resetDictationMeter,
  render: () => <PaneWithPill cleaning />
})

export const cleanupFailed = defineFixture({
  width: 520,
  store: { dictationState: 'idle' },
  render: () => <PaneWithPill notice="failed" />
})

export const cleanupTimedOut = defineFixture({
  width: 520,
  store: { dictationState: 'idle' },
  render: () => <PaneWithPill notice="timed-out" />
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

function PaneCountingDown() {
  const [deadline] = useState(() => performance.now() + 2000)
  return <PaneWithPill autoSend={{ deadline, delayMs: 2000 }} />
}

export const autoSendCountdown = defineFixture({
  width: 520,
  store: { dictationState: 'stopping' },
  setup: resetDictationMeter,
  render: () => <PaneCountingDown />
})

function speechModel(id: string, label: string): SpeechModelManifest {
  return {
    id,
    label,
    type: 'transducer',
    provider: 'local',
    language: 'en',
    languages: ['en'],
    sampleRate: 16000,
    streaming: false,
    sizeBytes: 740_000_000
  }
}

const parakeet = speechModel('parakeet', 'Parakeet')
const updateTarget: SpeechModelUpdateTarget = { model: parakeet }
const retiredTarget: SpeechModelUpdateTarget = {
  model: parakeet,
  retired: speechModel('zipformer', 'Zipformer')
}

function mockSpeechDownloads(downloadModel: () => Promise<void> = () => new Promise(() => {})) {
  Object.assign(window.api.speech, {
    onDownloadProgress: () => () => {},
    getModelStates: async () => [],
    downloadModel
  })
}

function withParakeet(state: Omit<SpeechModelState, 'id'>) {
  return { modelStates: [{ id: 'parakeet', ...state }] }
}

export const setupNotice = defineFixture({
  width: 520,
  store: withParakeet({ status: 'not-downloaded', needsUpdate: true }),
  setup: () => mockSpeechDownloads(),
  render: () => <PaneWithPill setup={updateTarget} />
})

export const setupRetiredNotice = defineFixture({
  width: 520,
  store: withParakeet({ status: 'not-downloaded' }),
  setup: () => mockSpeechDownloads(),
  render: () => <PaneWithPill setup={retiredTarget} />
})

export const setupDownloading = defineFixture({
  width: 520,
  store: withParakeet({ status: 'downloading', progress: 0.42 }),
  setup: () => mockSpeechDownloads(),
  render: () => <PaneWithPill setup={updateTarget} />
})

export const setupDone = defineFixture({
  width: 520,
  store: withParakeet({ status: 'ready' }),
  setup: () => mockSpeechDownloads(),
  render: () => <PaneWithPill setup={updateTarget} />
})

export const setupDoneRetired = defineFixture({
  width: 520,
  store: withParakeet({ status: 'ready' }),
  setup: () => mockSpeechDownloads(),
  render: () => <PaneWithPill setup={retiredTarget} />
})

export const setupFailed = defineFixture({
  width: 520,
  store: withParakeet({ status: 'not-downloaded', needsUpdate: true }),
  setup: () => mockSpeechDownloads(() => Promise.reject(new Error('network'))),
  render: () => <PaneWithPill setup={updateTarget} />,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-testid="dictation-setup-pill"] button')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})
