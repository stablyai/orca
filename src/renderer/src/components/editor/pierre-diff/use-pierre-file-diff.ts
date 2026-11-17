import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { PierreDiffInput } from './pierre-diff-metadata'
import { requestPierreFileDiff } from './pierre-diff-parse-client'
import { preparePierreDiffHighlight } from './pierre-diff-highlight'

// staleDiff: diff was kept from an earlier input after this input's parse failed.
type DiffSnapshot = {
  input: PierreDiffInput
  diff: FileDiffMetadata | null
  error: string | null
  staleDiff?: boolean
}

function sameDiffContent(a: PierreDiffInput | undefined, b: PierreDiffInput | null): boolean {
  return (
    a?.originalContent === b?.originalContent &&
    a?.modifiedContent === b?.modifiedContent &&
    a?.lang === b?.lang
  )
}

export function usePierreFileDiff(input: PierreDiffInput | null, editable = false) {
  const [snapshot, setSnapshot] = useState<DiffSnapshot | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const sameFile =
    snapshot?.input.cacheKey === input?.cacheKey && snapshot?.input.path === input?.path
  const currentContent = sameDiffContent(snapshot?.input, input) && !snapshot?.staleDiff
  const fileDiff =
    input && sameFile && (editable || currentContent) ? (snapshot?.diff ?? null) : null
  const renderedScopeRef = useRef<string | null>(null)
  const pendingRequest = useRef<AbortController | null>(null)
  const localEdit = useRef<{ input: PierreDiffInput; contents: string } | null>(null)
  const markEdited = useCallback(
    (contents?: string) => {
      pendingRequest.current?.abort()
      if (input && contents !== undefined) {
        localEdit.current = { input, contents }
      }
      // A resolved request can already be queued ahead of this edit's parent update.
      setSnapshot((previous) =>
        previous && previous.diff !== fileDiff ? { ...previous, diff: fileDiff } : previous
      )
    },
    [input, fileDiff]
  )
  const scope = input ? JSON.stringify([input.cacheKey, input.path]) : null
  const [primedScope, setPrimedScope] = useState<string | null>(null)

  useEffect(() => {
    if (!input) {
      return
    }
    const echo = localEdit.current
    if (
      echo &&
      echo.contents === input.modifiedContent &&
      echo.input.path === input.path &&
      echo.input.cacheKey === input.cacheKey &&
      echo.input.originalContent === input.originalContent &&
      echo.input.lang === input.lang &&
      echo.input.status === input.status &&
      echo.input.oldPath === input.oldPath &&
      JSON.stringify(echo.input.parseDiffOptions) === JSON.stringify(input.parseDiffOptions)
    ) {
      return
    }
    const controller = new AbortController()
    pendingRequest.current = controller
    // Coalesce external updates; local edit echoes keep the live session authoritative.
    const timer = setTimeout(
      () => {
        // Why: an already-rejected highlight enqueues onHighlightError before this then
        // commits the snapshot, so the error must be captured for both orderings.
        let highlightError: string | null = null
        void requestPierreFileDiff(input, controller.signal, false, (error: unknown) => {
          highlightError = error instanceof Error ? error.message : String(error)
          setSnapshot((previous) =>
            previous && previous.input === input ? { ...previous, error: highlightError } : previous
          )
        }).then(
          (diff) => {
            if (!controller.signal.aborted) {
              renderedScopeRef.current = JSON.stringify([input.cacheKey, input.path])
              setSnapshot((previous) =>
                controller.signal.aborted ? previous : { input, diff, error: highlightError }
              )
            }
          },
          (error: unknown) => {
            if (!controller.signal.aborted) {
              setSnapshot((previous) => {
                // Keep the last good render for this file. A transient worker or queue
                // failure must not unmount a live edit session under the user's cursor;
                // read-only views must not present that older content as this input's.
                const keep =
                  previous !== null &&
                  previous.input.cacheKey === input.cacheKey &&
                  previous.input.path === input.path
                return {
                  input,
                  diff: keep ? previous.diff : null,
                  error: error instanceof Error ? error.message : String(error),
                  staleDiff: keep && (previous.staleDiff || !sameDiffContent(previous.input, input))
                }
              })
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

  // Paint the parsed viewport first; attach only after the worker primes the editable AST.
  useEffect(() => {
    if (!editable || !fileDiff) {
      setPrimedScope(null)
      return
    }
    const controller = new AbortController()
    preparePierreDiffHighlight(fileDiff, controller.signal).then(
      () => {
        if (!controller.signal.aborted) {
          setPrimedScope(scope)
          // Why: retry re-primes immediately but same-file parse is coalesced 120ms,
          // so leaving this set keeps the banner up after recovery already succeeded.
          setSnapshot((previous) =>
            previous && previous.diff === fileDiff && previous.error
              ? { ...previous, error: null }
              : previous
          )
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
            ? fileDiff.lang?.startsWith('orca-plugin-syntax-')
              ? { ...previous, diff: { ...fileDiff, lang: 'text' }, error: null }
              : { ...previous, error: error instanceof Error ? error.message : String(error) }
            : previous
        )
      }
    )
    return () => controller.abort()
    // Why attempt: retry is the only recovery after a prime rejection, and parse can
    // return the same FileDiffMetadata object, which would otherwise skip this effect.
  }, [attempt, editable, fileDiff, scope])

  return {
    fileDiff,
    error: snapshot?.input === input ? snapshot.error : null,
    retry,
    markEdited,
    editReady: !editable || (scope !== null && primedScope === scope)
  }
}
