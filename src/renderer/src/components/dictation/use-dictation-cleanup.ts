import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '@/store'
import {
  isDictationCleanupOn,
  type DictationCleanupResult
} from '../../../../shared/dictation-cleanup'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { appendDictationText } from '../../../../shared/dictation-transcript-spacing'
import { dictationPillAnchorFor, type DictationPillAnchor } from './dictation-pill-anchor'
import type { DictationKeptRecording } from './dictation-kept-recording'

const NOTICE_MS = 4000

export type DictationCleanupNotice = {
  kind: 'failed' | 'timed-out'
  anchor: DictationPillAnchor | null
}

/** Whether this desktop cleans dictated text itself; a paired web client's host does it in `speech.dictation.finish`. */
export function shouldHoldForCleanup(): boolean {
  const settings = useAppStore.getState().settings
  return Boolean(window.api.speech.cleanUpDictation && settings && isDictationCleanupOn(settings))
}

/** Runs AI cleanup on the session's held words at finish; ✕ skips it, and the words then land as heard. */
export function useDictationCleanup(keptRef: RefObject<DictationKeptRecording | null>) {
  const [cleaning, setCleaning] = useState(false)
  const [notice, setNotice] = useState<DictationCleanupNotice | null>(null)
  const skipRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!notice) {
      return
    }
    const id = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [notice])

  /** Lands the held words once: cleaned, or as heard when cleanup fails, takes too long or is skipped. */
  const land = useCallback(async (): Promise<void> => {
    const kept = keptRef.current
    const heard = kept?.deliver.held() ?? null
    const cleanUp = window.api.speech.cleanUpDictation
    if (!kept || heard === null || !cleanUp) {
      kept?.deliver.releaseHeld()
      return
    }
    const requestId = createNonSecureContextUuid()
    const skipped = Promise.withResolvers<DictationCleanupResult>()
    skipRef.current = () => {
      skipped.resolve({ status: 'canceled' })
      void window.api.speech.cancelDictationCleanup?.(requestId).catch(() => undefined)
    }
    setNotice(null)
    setCleaning(true)
    const result = await Promise.race([
      cleanUp(heard, kept.context, requestId).catch((error: unknown): DictationCleanupResult => ({
        status: 'failed',
        reason: String(error)
      })),
      skipped.promise
    ])
    skipRef.current = null
    setCleaning(false)
    // A final that arrived during cleanup follows the cleaned words instead of being dropped.
    const late = kept.deliver.held()?.slice(heard.length) ?? ''
    kept.deliver.releaseHeld(
      result.status === 'cleaned' ? appendDictationText(result.text, late.trim()) : undefined
    )
    if (result.status === 'failed') {
      console.warn('[dictation] AI cleanup failed:', result.reason)
    }
    if (result.status === 'failed' || result.status === 'timed-out') {
      setNotice({ kind: result.status, anchor: dictationPillAnchorFor(kept.target) })
    }
  }, [keptRef])

  /** Skips a cleanup in progress (true), else lands any held words as heard: the session ends unfinished. */
  const interrupt = useCallback((): boolean => {
    const skip = skipRef.current
    if (skip) {
      skip()
      return true
    }
    keptRef.current?.deliver.releaseHeld()
    return false
  }, [keptRef])

  const dismissNotice = useCallback(() => setNotice(null), [])

  return { cleaning, notice, land, interrupt, dismissNotice }
}
