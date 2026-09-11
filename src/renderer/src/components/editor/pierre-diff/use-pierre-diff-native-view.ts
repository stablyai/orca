import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { FileDiffMetadata, PostRenderPhase } from '@pierre/diffs'
import type { Editor } from '@pierre/diffs/edit'
import type { PierreDiffInstance } from './PierreDiffSurface'
import { scrollPierreDiffToLine } from './pierre-diff-scroll'
import {
  getPierreNativeView,
  type PierreNativeViewState,
  readPierreNativeSelection,
  rememberPierreNativeView,
  restorePierreNativeSelection
} from './pierre-diff-native-view-state'

// The editor reasserts its own selection on attach, which can land well after ours. Budget by
// wall clock, not frames: under load a frame count expires long before the editor settles.
// User interaction still cancels the pending restore, so this only bounds the quiet case.
// The editor reasserts its own selection well after ours, and convergence needs a later Pierre
// render, so the window extends on each render while a restore is still pending. RESTORE_CEILING
// is the hard bound: past it no further extension is granted, so a row that renders forever
// without converging cannot spin forever. User interaction cancels the restore sooner still.
const RESTORE_DEADLINE_MS = 2_000
const RESTORE_CEILING_MS = 15_000

export function usePierreDiffNativeView(
  key: string | undefined,
  fileDiff: FileDiffMetadata,
  editable: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  activeGroupId: string,
  editorRef: React.RefObject<Pick<Editor, 'setDeletedTextSelectionActive'> | null>
) {
  const view = useRef<{ host: HTMLElement; instance: PierreDiffInstance } | null>(null)
  const latest = useRef({ fileDiff, editable, activeGroupId })
  useLayoutEffect(() => {
    latest.current = { fileDiff, editable, activeGroupId }
  }, [fileDiff, editable, activeGroupId])
  const [restoreSeed] = useState(() => (key ? getPierreNativeView(key) : undefined))
  const pending = useRef(restoreSeed)
  const frame = useRef<number | null>(null)
  // Armed on attach; 0 until then so a stale ref can never keep a restore alive.
  const deadline = useRef(0)
  const ceiling = useRef(0)
  const lastSnapshot = useRef<PierreNativeViewState | undefined>(undefined)
  const schedule = useCallback(() => {
    if (frame.current !== null || !pending.current || Date.now() > deadline.current) {
      return
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const current = view.current,
        saved = pending.current
      if (!current || !saved || !current.host.isConnected) {
        return
      }
      if (latest.current.editable && !editorRef.current) {
        schedule()
        return
      }
      const group = current.host.closest<HTMLElement>('[data-tab-group-body-id]')
      if (
        saved.selection &&
        group &&
        group.dataset.tabGroupBodyId !== latest.current.activeGroupId
      ) {
        current.instance.setCodeScrollLeft(saved.scrollLeft)
        return
      }
      const selected = readPierreNativeSelection(
        current.host,
        latest.current.fileDiff,
        latest.current.editable
      )
      if (saved.selection?.side === 'deletions') {
        editorRef.current?.setDeletedTextSelectionActive(true)
      }
      if (
        current.instance.getCodeScrollLeft() === saved.scrollLeft &&
        JSON.stringify(selected) === JSON.stringify(saved.selection)
      ) {
        pending.current = undefined
        return
      }
      current.instance.setCodeScrollLeft(saved.scrollLeft)
      if (
        !saved.selection ||
        restorePierreNativeSelection(
          current.host,
          latest.current.fileDiff,
          saved.selection,
          current.instance,
          editorRef.current
        )
      ) {
        // Editor initialization may replace the selected nodes on its next frame.
        schedule()
      } else {
        const { range, side } = saved.selection
        scrollPierreDiffToLine({
          host: current.host,
          container: current.host.closest('.scrollbar-editor'),
          side,
          lineNumber: range.startLineNumber,
          linePosition: current.instance.getLinePosition?.(range.startLineNumber, side),
          hunkIndex: 0,
          hunkCount: 0
        })
        schedule()
      }
    })
  }, [editorRef])
  useLayoutEffect(() => {
    const now = Date.now()
    ceiling.current = now + RESTORE_CEILING_MS
    deadline.current = now + RESTORE_DEADLINE_MS
    schedule()
  }, [activeGroupId, schedule])
  useLayoutEffect(() => {
    const container = containerRef.current
    const cancel = () => {
      pending.current = undefined
    }
    const capture = (requireOwnership = false) => {
      const current = view.current
      if (!key || !current) {
        return
      }
      const selection = readPierreNativeSelection(
        current.host,
        latest.current.fileDiff,
        latest.current.editable
      )
      if (requireOwnership && !selection && !container?.contains(document.activeElement)) {
        return
      }
      lastSnapshot.current = {
        scrollLeft: current.instance.getCodeScrollLeft(),
        selection
      }
      rememberPierreNativeView(key, lastSnapshot.current)
    }
    // Capture before a tab/header click clears the native selection and disposes Pierre.
    const captureBeforePointerDown = (event: PointerEvent) => {
      if (container && !event.composedPath().includes(container)) {
        capture(true)
      } else {
        lastSnapshot.current = undefined
      }
    }
    const captureBeforeKeyDown = (event: KeyboardEvent) => {
      if (
        container &&
        event.composedPath().includes(container) &&
        (event.getModifierState('Control') || event.getModifierState('Meta'))
      ) {
        capture(true)
      }
    }
    const captureOnBlur = () => capture(true)
    document.addEventListener('pointerdown', captureBeforePointerDown, true)
    document.addEventListener('keydown', captureBeforeKeyDown, true)
    window.addEventListener('blur', captureOnBlur)
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('wheel', cancel, true)
    document.addEventListener('keydown', cancel, true)
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
      }
      frame.current = null
      document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('wheel', cancel, true)
      document.removeEventListener('keydown', cancel, true)
      document.removeEventListener('pointerdown', captureBeforePointerDown, true)
      document.removeEventListener('keydown', captureBeforeKeyDown, true)
      window.removeEventListener('blur', captureOnBlur)
      if (!lastSnapshot.current) {
        capture()
      }
    }
  }, [key, containerRef])
  return useCallback(
    (host: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => {
      if (phase !== 'unmount') {
        view.current = { host, instance }
        const now = Date.now()
        if (phase === 'mount') {
          ceiling.current = now + RESTORE_CEILING_MS
        }
        // Extend while a restore is still pending, but never past the ceiling.
        if (pending.current && now < ceiling.current) {
          deadline.current = Math.min(now + RESTORE_DEADLINE_MS, ceiling.current)
        }
        schedule()
      }
    },
    [schedule]
  )
}
