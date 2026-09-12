import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  // read the current value (an editable surface blocks on the highlight). Written in a layout
  // effect, not during render -- React can discard a render, and the request reads this from a
  // timeout scheduled by a passive effect, which always runs after layout effects.
  const editableRef = useRef(editable)
  useLayoutEffect(() => {
    editableRef.current = editable
  }, [editable])
  // Start true when the surface mounted editable so the blocking request path can paint once.
  // Staging/unstaging sets this false while !editable, so the flip commit already gates `edit`.
  const [primeReady, setPrimeReady] = useState(editable)

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

  // Why: staging or unstaging flips a row's editability without changing its content. Priming
  // here is not enough by itself -- Pierre's applyEdit runs in a child layout effect of the same
  // commit, so `edit` must already be false on the flip render or it highlights the whole file
  // synchronously. `primeReady` stays false while !editable, then this fills the AST and flips it.
  useEffect(() => {
    if (!editable) {
      setPrimeReady(false)
      return
    }
    if (!fileDiff) {
      return
    }
    const controller = new AbortController()
    preparePierreDiffHighlight(fileDiff, controller.signal).then(
      () => {
        if (!controller.signal.aborted) {
          setPrimeReady(true)
        }
      },
      (error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return
        }
        setSnapshot((previous) =>
          previous && previous.diff === fileDiff
            ? { ...previous, error: error instanceof Error ? error.message : String(error) }
            : previous
        )
      }
    )
    return () => controller.abort()
  }, [editable, fileDiff])

  return {
    fileDiff,
    error: snapshot?.input === input ? snapshot.error : null,
    retry,
    markEdited,
    editReady: !editable || primeReady
  }
}
