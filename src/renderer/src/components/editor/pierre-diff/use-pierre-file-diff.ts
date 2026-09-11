import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { PierreDiffInput } from './pierre-diff-metadata'
import { requestPierreFileDiff } from './pierre-diff-parse-client'
import { preparePierreDiffHighlight } from './pierre-diff-highlight'

type DiffSnapshot = { input: PierreDiffInput; diff: FileDiffMetadata | null; error: string | null }

export function usePierreFileDiff(input: PierreDiffInput | null, editable = false) {
  const [snapshot, setSnapshot] = useState<DiffSnapshot | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const sameFile =
    snapshot?.input.cacheKey === input?.cacheKey && snapshot?.input.path === input?.path
  const fileDiff = input && sameFile ? (snapshot?.diff ?? null) : null
  const renderedScopeRef = useRef<string | null>(null)
  const pendingRequest = useRef<AbortController | null>(null)
  const markEdited = useCallback(() => pendingRequest.current?.abort(), [])
  // Why a ref: flipping editability must not re-parse the file, but the next request still has to
  // read the current value (an editable surface blocks on the highlight).
  const editableRef = useRef(editable)
  editableRef.current = editable

  useEffect(() => {
    if (!input) {
      return
    }
    const controller = new AbortController()
    pendingRequest.current = controller
    // Edits already paint through Pierre; coalesce parent echoes before recomputing.
    const timer = setTimeout(
      () => {
        void requestPierreFileDiff(
          input,
          controller.signal,
          editableRef.current,
          (error: unknown) =>
            setSnapshot((previous) =>
              previous && previous.input === input
                ? { ...previous, error: error instanceof Error ? error.message : String(error) }
                : previous
            )
        ).then(
          (diff) => {
            if (!controller.signal.aborted) {
              renderedScopeRef.current = JSON.stringify([input.cacheKey, input.path])
              setSnapshot({ input, diff, error: null })
            }
          },
          (error: unknown) => {
            if (!controller.signal.aborted) {
              setSnapshot((previous) => ({
                input,
                // Keep the last good render for this file. A transient worker or queue
                // failure must not unmount a live edit session under the user's cursor;
                // the error is surfaced alongside the still-rendered diff instead.
                diff:
                  previous &&
                  previous.input.cacheKey === input.cacheKey &&
                  previous.input.path === input.path
                    ? previous.diff
                    : null,
                error: error instanceof Error ? error.message : String(error)
              }))
            }
          }
        )
      },
      renderedScopeRef.current === JSON.stringify([input.cacheKey, input.path]) ? 120 : 0
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [input, attempt])

  // Why: staging or unstaging flips a row's editability without changing its content. Priming here
  // keeps the guarantee the blocking path gives a surface that mounted editable -- entering edit
  // mode with an unprimed AST makes Pierre highlight the whole file synchronously.
  useEffect(() => {
    if (!editable || !fileDiff) {
      return
    }
    const controller = new AbortController()
    preparePierreDiffHighlight(fileDiff, controller.signal).catch(() => {})
    return () => controller.abort()
  }, [editable, fileDiff])

  return { fileDiff, error: snapshot?.input === input ? snapshot.error : null, retry, markEdited }
}
