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

/** A composer's Send while it's being dictated into: true when the send now waits for the words. */
export function queueComposerSendAfterDictation(root: HTMLElement, send: () => void): boolean {
  return composerSendQueue?.(root, send) ?? false
}

/** Enter or Send during a dictation stops it, then sends once its words have landed. */
export function useDictationQueuedSend(
  sessionRef: RefObject<DictationSession>,
  keptRef: RefObject<DictationKeptRecording | null>
) {
  const queuedRef = useRef<{ run: number; send: () => void } | null>(null)
  const [queuedKind, setQueuedKind] = useState<DictationQueuedSendKind | null>(null)

  const queue = useCallback(
    (kind: DictationQueuedSendKind, send: () => void): boolean => {
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
      return (
        target?.kind === 'terminal' &&
        eventTarget instanceof Node &&
        target.pane.contains(eventTarget) &&
        queue('terminal', () => void pressDictationTerminalEnter(target))
      )
    },
    [keptRef, queue]
  )

  const clear = useCallback(() => {
    queuedRef.current = null
    setQueuedKind(null)
  }, [])

  /** Runs this session's queued send once its words land; none if any went to the clipboard. */
  const release = useCallback(
    (run: number) => {
      const queued = queuedRef.current
      const delivery = keptRef.current?.deliver
      clear()
      if (queued?.run === run && delivery) {
        void delivery.settled().then((landed) => landed && queued.send())
      }
    },
    [keptRef, clear]
  )

  return { queuedKind, queueTerminalEnter, release, clear }
}
