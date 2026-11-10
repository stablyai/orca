import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { dictationAutoSendDelayMs } from '../../../../shared/constants'
import {
  canStartDictation,
  isDictationUnderway,
  type DictationSession
} from '../../../../shared/dictation-session-machine'
import type { DictationState } from '../../../../shared/speech-types'
import { dispatchDictationControl } from './dictation-control-events'
import { pressDictationTerminalEnter } from './dictation-insertion-target'
import type { DictationKeptRecording } from './dictation-kept-recording'

export type DictationQueuedSendKind = 'chat' | 'terminal'

/** "Sending in Ns": when the dictated message sends, and the whole wait, which is announced once. */
export type DictationAutoSendCountdown = { deadline: number; delayMs: number }

type QueuedSend = (stillQueued: () => boolean) => void | Promise<void>

type ComposerSendQueue = (root: HTMLElement, send: () => void) => boolean
let composerSendQueue: ComposerSendQueue | null = null

// Composers whose Send may run on its own once a dictation into them ends.
const composerAutoSends = new WeakMap<HTMLElement, () => void>()

/**
 * A composer's Send: while it's being dictated into, it waits for the last words to land and render,
 * then sends them too. With `sendsWhenDictationEnds`, the "Send when dictation ends" setting presses it.
 */
export function useSendAfterDictation<Intent>(
  root: RefObject<HTMLElement | null>,
  sendMessage: (intent?: Intent) => void,
  sendsWhenDictationEnds: boolean
): (intent?: Intent) => void {
  const pendingRef = useRef<{ intent?: Intent } | null>(null)
  const [landedTick, setLandedTick] = useState(0)
  useEffect(() => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) {
      sendMessage(pending.intent)
    }
  }, [landedTick, sendMessage])
  const sendOnceRendered = useCallback((intent?: Intent) => {
    pendingRef.current = { intent }
    setLandedTick((tick) => tick + 1)
  }, [])
  useEffect(() => {
    const element = root.current
    if (!sendsWhenDictationEnds || !element) {
      return
    }
    const autoSend = (): void => sendOnceRendered()
    composerAutoSends.set(element, autoSend)
    return () => {
      if (composerAutoSends.get(element) === autoSend) {
        composerAutoSends.delete(element)
      }
    }
  }, [root, sendsWhenDictationEnds, sendOnceRendered])
  return (intent) => {
    if (!root.current || !composerSendQueue?.(root.current, () => sendOnceRendered(intent))) {
      sendMessage(intent)
    }
  }
}

async function sendIfStillQueued(
  send: QueuedSend,
  landed: boolean,
  stillQueued: () => boolean
): Promise<void> {
  if (landed && stillQueued()) {
    await send(stillQueued)
  }
}

// Dictation's own insertion fires input, so input counts only once the countdown shows.
const COMPOSER_TAKEOVER_EVENTS = [
  'keydown',
  'paste',
  'drop',
  'compositionstart',
  'focusout',
  'input'
]
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

function isAppActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Calls onTakeover when the user types, pastes, drops, composes, presses anywhere, or leaves the composer or app. */
function watchComposerTakeover(
  root: HTMLElement,
  countingDown: () => boolean,
  onTakeover: () => void
): () => void {
  const listening = new AbortController()
  const options = { capture: true, signal: listening.signal }
  const onComposerEvent = (event: Event): void => {
    const notTakeover =
      (event.type === 'input' && !countingDown()) ||
      (event instanceof KeyboardEvent && MODIFIER_KEYS.has(event.key)) ||
      (event instanceof FocusEvent &&
        event.relatedTarget instanceof Node &&
        root.contains(event.relatedTarget))
    if (!notTakeover) {
      onTakeover()
    }
  }
  const onAppLeave = (): void => {
    if (!isAppActive()) {
      onTakeover()
    }
  }
  for (const type of COMPOSER_TAKEOVER_EVENTS) {
    root.addEventListener(type, onComposerEvent, options)
  }
  // Caret clicks, suggestion picks and clicks elsewhere fire none of the composer's own events.
  document.addEventListener('pointerdown', onTakeover, options)
  window.addEventListener('blur', onAppLeave, options)
  document.addEventListener('visibilitychange', onAppLeave, options)
  return () => listening.abort()
}

type AutoSendWatch = {
  run: number
  root: HTMLElement
  takenOver: boolean
  /** Set while the pill counts down; ends the wait early. */
  endCountdown: (() => void) | null
  stopWatching: () => void
}

/** Enter or Send during a dictation stops it, then sends once its words have landed. */
export function useDictationQueuedSend(
  sessionRef: RefObject<DictationSession>,
  keptRef: RefObject<DictationKeptRecording | null>
) {
  const queuedRef = useRef<{ run: number; send: QueuedSend } | null>(null)
  const [queuedKind, setQueuedKind] = useState<DictationQueuedSendKind | null>(null)
  const autoSendRef = useRef<AutoSendWatch | null>(null)
  const [autoSend, setAutoSend] = useState<DictationAutoSendCountdown | null>(null)
  const autoSendOn = useAppStore(
    (s) => s.settings?.voice?.enabled === true && s.settings.voice.autoSendAfterDictation === true
  )

  /** Keeps the dictated draft unsent; true when the countdown was showing, so the finished session can end now. */
  const takeOverAutoSend = useCallback((): boolean => {
    const watch = autoSendRef.current
    if (!watch || watch.takenOver) {
      return false
    }
    watch.takenOver = true
    watch.stopWatching()
    const countingDown = watch.endCountdown !== null
    watch.endCountdown?.()
    return countingDown
  }, [])

  useEffect(() => {
    if (!autoSendOn) {
      takeOverAutoSend()
    }
  }, [autoSendOn, takeOverAutoSend])

  const queue = useCallback(
    (kind: DictationQueuedSendKind, send: QueuedSend): boolean => {
      const { phase, run, sessionId } = sessionRef.current
      if (sessionId === null || !(isDictationUnderway(phase) || phase === 'stopping')) {
        return false
      }
      queuedRef.current = { run, send }
      setQueuedKind(kind)
      // A Send during the countdown sends now.
      autoSendRef.current?.endCountdown?.()
      dispatchDictationControl('stop')
      return true
    },
    [sessionRef]
  )

  useEffect(() => {
    composerSendQueue = (root, send) => {
      const target = keptRef.current?.target
      return target?.kind === 'composer' && target.root === root && queue('chat', send)
    }
    return () => {
      composerSendQueue = null
    }
  }, [keptRef, queue])

  /** Plain Enter typed in the pane being dictated into; true when it's held until the words land. */
  const queueTerminalEnter = useCallback(
    (eventTarget: EventTarget | null): boolean => {
      const target = keptRef.current?.target
      // Only the pane's own terminal input: its search box and chat cover are portaled into the pane too.
      return (
        target?.kind === 'terminal' &&
        eventTarget instanceof HTMLElement &&
        eventTarget.classList.contains('xterm-helper-textarea') &&
        eventTarget.closest('.pane[data-pane-id]') === target.pane &&
        queue('terminal', (stillQueued) => pressDictationTerminalEnter(target, stillQueued))
      )
    },
    [keptRef, queue]
  )

  const clear = useCallback(() => {
    queuedRef.current = null
    setQueuedKind(null)
    takeOverAutoSend()
    autoSendRef.current = null
  }, [takeOverAutoSend])

  // Only a chat composer that sends on its own, still focused in the active app when dictation stops.
  const watchForAutoSend = useCallback(
    (run: number): AutoSendWatch | null => {
      const voice = useAppStore.getState().settings?.voice
      const target = keptRef.current?.target
      if (
        !voice?.enabled ||
        !voice.autoSendAfterDictation ||
        target?.kind !== 'composer' ||
        !composerAutoSends.has(target.root) ||
        !target.root.contains(document.activeElement) ||
        !isAppActive()
      ) {
        return null
      }
      const watch: AutoSendWatch = {
        run,
        root: target.root,
        takenOver: false,
        endCountdown: null,
        stopWatching: () => {}
      }
      watch.stopWatching = watchComposerTakeover(
        target.root,
        () => watch.endCountdown !== null,
        takeOverAutoSend
      )
      return watch
    },
    [keptRef, takeOverAutoSend]
  )

  /** Tracks each session change: drops the send once the session is gone, and watches for a takeover from Stop on. */
  const follow = useCallback(
    (session: DictationSession): void => {
      if (session.phase === 'idle' || session.phase === 'error') {
        clear()
      } else if (session.phase === 'stopping') {
        takeOverAutoSend()
        autoSendRef.current = session.sessionId === null ? null : watchForAutoSend(session.run)
      }
    },
    [clear, takeOverAutoSend, watchForAutoSend]
  )

  /** The pill counts down, then the deadline queues the composer's Send as Enter would. */
  const countDownToAutoSend = useCallback((watch: AutoSendWatch): Promise<void> => {
    const delayMs = dictationAutoSendDelayMs(useAppStore.getState().settings?.voice)
    setAutoSend({ deadline: performance.now() + delayMs, delayMs })
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        const send = composerAutoSends.get(watch.root)
        if (send) {
          queuedRef.current = { run: watch.run, send }
        }
        resolve()
      }, delayMs)
      watch.endCountdown = () => {
        window.clearTimeout(timer)
        resolve()
      }
    }).finally(() => {
      watch.endCountdown = null
      setAutoSend(null)
    })
  }, [])

  /** Runs this session's queued send once its words land, none if any went to the clipboard; the pill waits for it. */
  const release = useCallback(
    async (run: number): Promise<void> => {
      const delivery = keptRef.current?.deliver
      const watch = autoSendRef.current?.run === run ? autoSendRef.current : null
      if ((queuedRef.current?.run !== run && !watch) || !delivery) {
        clear()
        return
      }
      const landed = await delivery.settled()
      // A cancel or failure while the words were landing drops the send.
      const stillQueued = (): boolean => sessionRef.current.run === run
      // Enter or Send while dictating already queued the send; with no speech there's nothing to send.
      if (
        watch &&
        !watch.takenOver &&
        queuedRef.current?.run !== run &&
        landed &&
        sessionRef.current.heardFinalText &&
        stillQueued()
      ) {
        await countDownToAutoSend(watch)
      }
      const queued = queuedRef.current
      if (queued?.run !== run) {
        return
      }
      await sendIfStillQueued(queued.send, landed, stillQueued).finally(() => {
        // A later session may have queued its own send meanwhile; leave that one alone.
        if (queuedRef.current === queued) {
          clear()
        }
      })
    },
    [keptRef, sessionRef, clear, countDownToAutoSend]
  )

  /** A new dictation can start once the session is done, or while only its countdown is left to take over. */
  const canStart = useCallback(
    (phase: DictationState) =>
      canStartDictation(phase) || Boolean(autoSendRef.current?.endCountdown),
    []
  )

  return {
    queuedKind,
    autoSend,
    queueTerminalEnter,
    release,
    follow,
    takeOverAutoSend,
    canStart
  }
}
