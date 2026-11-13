import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { dictationAutoSendDelayMs } from '../../../../shared/dictation-auto-send'
import {
  canStartDictation,
  isDictationUnderway,
  type DictationSession
} from '../../../../shared/dictation-session-machine'
import type { DictationState } from '../../../../shared/speech-types'
import { dispatchDictationControl } from './dictation-control-events'
import { pressDictationTerminalEnter } from './dictation-insertion-target'
import type { DictationKeptRecording } from './dictation-kept-recording'
import {
  isAppActive,
  watchForComposerTakeover,
  type AutoSendWatch
} from './dictation-composer-takeover'

export type DictationQueuedSendKind = 'chat' | 'terminal'

export type DictationAutoSendCountdown = { deadline: number; delayMs: number }

/** The countdown's send on its way through the composer's render; either call ends the takeover watch. */
type AutoSendHandoff = {
  /** True once, when the render reaches it and no one took over meanwhile. */
  claim: () => boolean
  /** The composer went away or replaced it before the render did. */
  dispose: () => void
}

type QueuedSend = (stillQueued: () => boolean) => void | Promise<void>

type ComposerSendQueue = (root: HTMLElement, send: () => void) => boolean
let composerSendQueue: ComposerSendQueue | null = null

const composerAutoSends = new WeakMap<HTMLElement, (handoff: AutoSendHandoff) => void>()
// The owner's hook for a composer that stops taking automatic sends, or now sends somewhere else.
let composerAutoSendRevoked: ((root: HTMLElement) => void) | null = null
// Recordings whose composer's destination changed after they started; only they lose auto-send.
const revokedRecordings = new WeakSet<DictationKeptRecording>()

type PendingSend<Intent> = { intent?: Intent; handoff?: AutoSendHandoff }

/**
 * A composer's Send: while it's being dictated into, it waits for the last words to land and render,
 * then sends them too. With `autoSendTo`, the conversation it sends to, "Send when dictation ends"
 * presses it; a different conversation there ends the countdown.
 */
export function useSendAfterDictation<Intent>(
  root: RefObject<HTMLElement | null>,
  sendMessage: (intent?: Intent) => void,
  autoSendTo: string | null
): (intent?: Intent) => void {
  const pendingRef = useRef<PendingSend<Intent> | null>(null)
  const [landedTick, setLandedTick] = useState(0)
  useEffect(() => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending && (!pending.handoff || pending.handoff.claim())) {
      sendMessage(pending.intent)
    }
  }, [landedTick, sendMessage])
  const dropPendingAutoSend = useCallback(() => {
    if (pendingRef.current?.handoff) {
      pendingRef.current.handoff.dispose()
      pendingRef.current = null
    }
  }, [])
  const sendOnceRendered = useCallback((pending: PendingSend<Intent>) => {
    pendingRef.current?.handoff?.dispose()
    pendingRef.current = pending
    setLandedTick((tick) => tick + 1)
  }, [])
  useEffect(() => {
    const element = root.current
    if (autoSendTo === null || !element) {
      return
    }
    const autoSend = (handoff: AutoSendHandoff): void => sendOnceRendered({ handoff })
    composerAutoSends.set(element, autoSend)
    composerAutoSendRevoked?.(element)
    return () => {
      if (composerAutoSends.get(element) === autoSend) {
        composerAutoSends.delete(element)
      }
      dropPendingAutoSend()
      composerAutoSendRevoked?.(element)
    }
  }, [root, autoSendTo, sendOnceRendered, dropPendingAutoSend])
  return (intent) => {
    if (!root.current || !composerSendQueue?.(root.current, () => sendOnceRendered({ intent }))) {
      // An explicit Send replaces a countdown send still waiting for this render.
      dropPendingAutoSend()
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
    if (!watch?.live) {
      return false
    }
    watch.live = false
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
    composerAutoSendRevoked = (root) => {
      const kept = keptRef.current
      if (kept?.target?.kind === 'composer' && kept.target.root === root) {
        revokedRecordings.add(kept)
      }
      if (autoSendRef.current?.root === root) {
        takeOverAutoSend()
      }
    }
    return () => {
      composerSendQueue = null
      composerAutoSendRevoked = null
    }
  }, [keptRef, queue, takeOverAutoSend])

  useEffect(
    () => () => {
      queuedRef.current = null
      takeOverAutoSend()
      autoSendRef.current = null
    },
    [takeOverAutoSend]
  )

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
    if (!autoSendRef.current?.handedOff) {
      takeOverAutoSend()
      autoSendRef.current = null
    }
  }, [takeOverAutoSend])

  // Only a chat composer that sends on its own, still focused in the active app when dictation stops.
  const watchForAutoSend = useCallback(
    (run: number): AutoSendWatch | null => {
      const voice = useAppStore.getState().settings?.voice
      const kept = keptRef.current
      const target = kept?.target
      if (
        (kept !== null && (kept.cutOff || revokedRecordings.has(kept))) ||
        !voice?.enabled ||
        !voice.autoSendAfterDictation ||
        target?.kind !== 'composer' ||
        !composerAutoSends.has(target.root) ||
        !target.root.contains(document.activeElement) ||
        !isAppActive()
      ) {
        return null
      }
      return watchForComposerTakeover(run, target.root, takeOverAutoSend)
    },
    [keptRef, takeOverAutoSend]
  )

  /** Drops the send once the session is gone, and watches for a takeover from Stop on. */
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

  const countDownToAutoSend = useCallback((watch: AutoSendWatch): Promise<void> => {
    const dispose = (): void => {
      watch.live = false
      watch.stopWatching()
      if (autoSendRef.current === watch) {
        autoSendRef.current = null
      }
    }
    const handoff: AutoSendHandoff = {
      claim: () => {
        const wanted = watch.live
        dispose()
        return wanted
      },
      dispose
    }
    const delayMs = dictationAutoSendDelayMs(useAppStore.getState().settings?.voice)
    setAutoSend({ deadline: performance.now() + delayMs, delayMs })
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        const send = composerAutoSends.get(watch.root)
        if (send) {
          const handOff = (): void => {
            watch.handedOff = true
            send(handoff)
          }
          queuedRef.current = { run: watch.run, send: handOff }
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
      if (
        watch?.live &&
        !keptRef.current?.cutOff &&
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

  /** A new dictation may also start during the countdown, which it takes over. */
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
