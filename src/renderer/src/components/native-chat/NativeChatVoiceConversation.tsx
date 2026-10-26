import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { voiceMessageText } from '../../../../shared/sts-voice-playback'
import { resolveRendererUiLocale } from '../../../../shared/ui-locale'
import { StsModelTurnTaking } from '../../../../shared/sts-model-turn-taking'
import { StsLocalModelClient } from './sts-local-model-client'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { completeNativeChatStructuredUserAction } from './native-chat-structured-user-action'
import { useNativeChatVoiceInput } from './use-native-chat-voice-input'
import { useNativeChatVoicePlayback } from './use-native-chat-voice-playback'
import { NativeChatVoicePanel } from './NativeChatVoicePanel'
import { nativeChatVoiceStateLabel } from './native-chat-voice-state-label'

export type NativeChatVoiceConversationProps = {
  active: boolean
  blocked: boolean
  working: boolean
  messages: readonly NativeChatMessage[]
  completedTurn?: string
  transport: NativeChatStructuredComposerTransport
  onStopAgent: () => void
}

export function NativeChatVoiceConversation(
  props: NativeChatVoiceConversationProps
): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [pendingSpeech, setPendingSpeech] = useState(false)
  const preparation = useRef(0)
  const models = useRef<StsLocalModelClient | null>(null)
  const [sending, setSending] = useState(false)
  const [awaiting, setAwaiting] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [notice, setNotice] = useState('')
  const [caption, setCaption] = useState('')
  const [queued, setQueued] = useState('')
  const queue = useRef('')
  const runningRef = useRef(false)
  const mounted = useRef(true)
  const sendInFlight = useRef(false)
  const workSeen = useRef(false)
  const replyBaseline = useRef('')
  const turnBaseline = useRef<string | undefined>(undefined)
  const gate = useRef<StsModelTurnTaking | null>(null)
  const latestAnswer = props.messages.findLast((message) => voiceMessageText(message).trim())
  const answer = latestAnswer ? voiceMessageText(latestAnswer) : ''
  const replyRevision = latestAnswer ? `${latestAnswer.id}:${answer}` : ''
  const voiceSettings = useAppStore((store) => store.settings?.voice)
  const language = useAppStore(
    (store) =>
      store.settings?.voice?.conversationLanguage ??
      resolveRendererUiLocale(store.settings?.uiLanguage ?? 'system')
  )
  const input = useNativeChatVoiceInput({
    active: props.active,
    autoSend: false,
    onReady: () => {},
    onBeforeStart: () => setNotice(''),
    onAudio: (samples, rate) => {
      if (runningRef.current) {
        models.current?.feed(samples, rate)
      }
    },
    onTranscript: (text, final) => {
      if (runningRef.current) {
        gate.current?.receive(text, final)
      }
    },
    onCaptureEnded: () => {
      if (!runningRef.current) {
        return
      }
      end()
      setNotice(
        translate('stsLive.captureEnded', 'Microphone capture ended. Start again to reconnect.')
      )
    }
  })
  const playback = useNativeChatVoicePlayback(
    props.messages,
    props.working,
    props.active && running,
    voiceSettings,
    interrupting,
    language
  )
  const canSend =
    props.active &&
    !props.blocked &&
    !props.working &&
    !sending &&
    !props.transport.sendOut &&
    !props.transport.sendBlockedReason &&
    !props.transport.sessionPending
  const replyFinished =
    !awaiting ||
    workSeen.current ||
    replyRevision !== replyBaseline.current ||
    (props.completedTurn !== undefined && props.completedTurn !== turnBaseline.current)
  const outputActive =
    playback.speaking || playback.pending || props.working || (awaiting && !replyFinished)

  function end(): void {
    const retained = gate.current?.pendingText
    if (retained) {
      enqueue(retained)
    }
    ++preparation.current
    setPreparing(false)
    models.current?.close()
    models.current = null
    runningRef.current = false
    setRunning(false)
    setAwaiting(false)
    setInterrupting(false)
    gate.current?.reset()
    playback.stop()
    input.cancel()
  }

  function interrupt(): void {
    playback.stop()
    setInterrupting(true)
    if (props.working || awaiting || sendInFlight.current) {
      props.onStopAgent()
    }
  }

  function enqueue(text: string): void {
    queue.current = [queue.current, text].filter(Boolean).join(' ')
    setQueued(queue.current)
    input.setDraft(queue.current)
  }

  function send(text: string): void {
    if (!text.trim() || !canSend || sendInFlight.current) {
      return
    }
    sendInFlight.current = true
    setSending(true)
    setNotice('')
    setInterrupting(false)
    workSeen.current = false
    replyBaseline.current = replyRevision
    turnBaseline.current = props.completedTurn
    queue.current = ''
    setQueued('')
    playback.restart()
    let settled = false
    const failed = (unconfirmed: boolean) => {
      if (settled) {
        return
      }
      settled = true
      sendInFlight.current = false
      if (!mounted.current) {
        return
      }
      queue.current = [text, queue.current].filter(Boolean).join(' ')
      setQueued(queue.current)
      input.setDraft(queue.current)
      setSending(false)
      end()
      setNotice(
        unconfirmed
          ? translate(
              'stsVoice.unconfirmed',
              'Delivery is unconfirmed. Check the chat before sending again.'
            )
          : translate(
              'stsVoice.notSent',
              'Not sent. Keep the text and send when the chat is ready.'
            )
      )
    }
    try {
      const result = props.transport.send(text, [], {
        callerKeepsText: true,
        onSettled: (outcome) => {
          if (settled) {
            return
          }
          if (outcome !== 'recorded') {
            failed(outcome === 'unconfirmed')
            return
          }
          settled = true
          sendInFlight.current = false
          if (!mounted.current) {
            return
          }
          setSending(false)
          input.setDraft(queue.current)
          setAwaiting(runningRef.current)
        }
      })
      if (result === false) {
        failed(false)
      } else {
        completeNativeChatStructuredUserAction('codex', props.transport, result === true)
      }
    } catch {
      failed(true)
    }
  }

  const callbacks = useRef({
    interrupt,
    enqueue,
    outputActive,
    playbackText: playback.speaking ? playback.caption : ''
  })
  callbacks.current = {
    interrupt,
    enqueue,
    outputActive,
    playbackText: playback.speaking ? playback.caption : ''
  }
  useEffect(() => {
    mounted.current = true
    ++preparation.current
    gate.current = new StsModelTurnTaking({
      output: () =>
        callbacks.current.outputActive
          ? {
              text: callbacks.current.playbackText
            }
          : null,
      predict: (text, output, final) => {
        if (!models.current) {
          return Promise.reject(new Error('turn_model_unavailable'))
        }
        return models.current.predict(text, output, final)
      },
      error: () =>
        setNotice(
          translate(
            'stsLocal.failed',
            'Local voice judgment failed. Your captions are kept; use Send spoken words or restart voice.'
          )
        ),
      waiting: () =>
        setNotice(
          translate(
            'stsLocal.waiting',
            'Waiting for the rest of your sentence. Keep speaking, or send the words now.'
          )
        ),
      pending: (value) => {
        if (mounted.current) {
          setPendingSpeech(value)
        }
      },
      clearAudio: () => models.current?.resetAudio(),
      interrupt: () => {
        if (runningRef.current) {
          callbacks.current.interrupt()
        }
      },
      utterance: (text) => {
        if (runningRef.current) {
          callbacks.current.enqueue(text)
        }
      },
      caption: setCaption
    })
    return () => {
      mounted.current = false
      runningRef.current = false
      models.current?.close()
      models.current = null
      gate.current?.close()
    }
  }, [])
  useEffect(() => {
    if (props.working && (awaiting || sending)) {
      workSeen.current = true
    }
  }, [props.working, awaiting, sending])
  useEffect(() => {
    if (!outputActive) {
      gate.current?.outputEnded()
    }
  }, [outputActive])
  useEffect(() => {
    if (running && queued && canSend && (replyFinished || interrupting)) {
      send(queued)
    }
  })
  useEffect(() => {
    if (
      (running || preparing) &&
      (!props.active || !input.ready || input.error || !playback.available)
    ) {
      end()
    }
  })

  const stateLabel = nativeChatVoiceStateLabel(
    { preparing, interrupting, sending, awaiting, replyFinished },
    props.working,
    input,
    playback
  )
  return (
    <>
      <textarea
        ref={input.inputRef}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        readOnly
        value={input.draft}
      />
      <NativeChatVoicePanel
        running={running || preparing}
        listening={input.owned}
        speaking={playback.speaking}
        stateLabel={stateLabel}
        startDisabled={
          !canSend ||
          !input.ready ||
          !playback.available ||
          input.state !== 'idle' ||
          Boolean(input.draft)
        }
        canInterrupt={running && !interrupting && outputActive}
        userCaption={caption || input.draft}
        assistantCaption={answer}
        modelLabel={translate('stsLocal.label', 'Local AI turn detection · experimental')}
        canSubmitSpoken={running && pendingSpeech}
        onSubmitSpoken={() => gate.current?.submit()}
        notice={
          notice ||
          input.error ||
          (playback.error
            ? translate(
                'stsLive.audioFailed',
                'Audio playback failed. Listening continues; check Voice settings.'
              )
            : '')
        }
        setupNeeded={!input.ready || !playback.available}
        retainedDraft={!running && Boolean(input.draft)}
        canRetry={canSend && input.state === 'idle'}
        onRetry={() => send(input.draft)}
        onDiscard={() => {
          queue.current = ''
          setQueued('')
          input.setDraft('')
          setNotice('')
        }}
        onToggle={async () => {
          if (running || preparing) {
            end()
            if (props.working) {
              props.onStopAgent()
            }
            return
          }
          gate.current?.reset()
          playback.restart()
          setNotice('')
          setAwaiting(false)
          const generation = ++preparation.current
          setPreparing(true)
          const client = new StsLocalModelClient()
          models.current = client
          try {
            const load = window.api.speech.loadTurnModels
            if (!load) {
              throw new Error('local_turn_models_unsupported')
            }
            await client.start(load)
          } catch {
            if (generation !== preparation.current || !mounted.current) {
              return
            }
            end()
            setNotice(
              translate(
                'stsLocal.setupFailed',
                'Could not prepare local voice models. Check the connection and restart voice. No cloud judgment was used.'
              )
            )
            return
          }
          if (generation !== preparation.current || !mounted.current) {
            return
          }
          setPreparing(false)
          runningRef.current = true
          setRunning(true)
          if (!input.start()) {
            end()
          }
        }}
        onInterrupt={() => {
          gate.current?.reset()
          interrupt()
        }}
      />
    </>
  )
}
