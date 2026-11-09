import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  isDictationUnderway,
  type DictationSession
} from '../../../../shared/dictation-session-machine'
import { dispatchDictationControl } from './dictation-control-events'
import { pressDictationTerminalEnter } from './dictation-insertion-target'
import type { DictationKeptRecording } from './dictation-kept-recording'

export type DictationQueuedSendKind = 'chat' | 'terminal'

type ComposerSendQueue = (root: HTMLElement, send: () => void) => boolean
let composerSendQueue: ComposerSendQueue | null = null

/**
 * A composer's Send: while it's being dictated into, it waits for the last words to land and render,
 * then sends them too.
 */
export function useSendAfterDictation<Intent>(
  root: RefObject<HTMLElement | null>,
  sendMessage: (intent?: Intent) => void
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
  return (intent) => {
    const queue = (): void => {
      pendingRef.current = { intent }
      setLandedTick((tick) => tick + 1)
    }
    if (!root.current || !composerSendQueue?.(root.current, queue)) {
      sendMessage(intent)
    }
  }
}

/** Enter or Send during a dictation stops it, then sends once its words have landed. */
export function useDictationQueuedSend(
  sessionRef: RefObject<DictationSession>,
  keptRef: RefObject<DictationKeptRecording | null>
) {
  const queuedRef = useRef<{ run: number; send: () => void | Promise<void> } | null>(null)
  const [queuedKind, setQueuedKind] = useState<DictationQueuedSendKind | null>(null)

  const queue = useCallback(
    (kind: DictationQueuedSendKind, send: () => void | Promise<void>): boolean => {
      const { phase, run, sessionId } = sessionRef.current
      if (sessionId === null || !(isDictationUnderway(phase) || phase === 'stopping')) {
        return false
      }
      queuedRef.current = { run, send }
      setQueuedKind(kind)
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
        queue('terminal', () => pressDictationTerminalEnter(target))
      )
    },
    [keptRef, queue]
  )

  const clear = useCallback(() => {
    queuedRef.current = null
    setQueuedKind(null)
  }, [])

  /** Runs this session's queued send once its words land, none if any went to the clipboard; the pill waits for it. */
  const release = useCallback(
    async (run: number): Promise<void> => {
      const queued = queuedRef.current
      const delivery = keptRef.current?.deliver
      if (queued?.run !== run || !delivery) {
        clear()
        return
      }
      const landed = await delivery.settled()
      // A cancel while the words were landing already dropped the send.
      if (sessionRef.current.run !== run) {
        return
      }
      clear()
      if (landed) {
        await queued.send()
      }
    },
    [keptRef, sessionRef, clear]
  )

  return { queuedKind, queueTerminalEnter, release, clear }
}
