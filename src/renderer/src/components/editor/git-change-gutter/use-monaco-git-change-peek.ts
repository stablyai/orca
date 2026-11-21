import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { installDiffCommentZoneMouseDownStopper } from '../../diff-comments/diff-comment-zone-mouse-events'
import {
  computeGitChangeInlineDiff,
  type GitChangeOriginalSegment
} from './git-change-hunk-inline-diff'
import { buildGitChangeHunkRevertEdit } from './git-change-hunk-revert'
import { computeGitChangeHunks, type GitChangeHunk } from './git-change-hunks'
import type { GitHeadBaseline } from './git-head-baseline-cache'

// editor.MouseTargetType.GUTTER_LINE_DECORATIONS, inlined to keep this module free of a runtime Monaco import.
const GUTTER_LINE_DECORATIONS_TARGET = 4
// editor.ContentWidgetPositionPreference, inlined for the same reason.
const WIDGET_ABOVE = 1
const WIDGET_BELOW = 2
const PEEK_WIDGET_ID = 'orca.gitChangePeek'
const GUTTER_MARK_CLASS = 'orca-git-change-gutter'

export type GitChangePeekModel = {
  domNode: HTMLElement
  /** Empty for added lines, which have no baseline to show. */
  originalSegments: readonly GitChangeOriginalSegment[]
  total: number
  onPrevious: () => void
  onNext: () => void
  onCopy: () => void
  onRevert: () => void
  onClose: () => void
  onContentResize: () => void
}

function isSameHunk(a: GitChangeHunk, b: GitChangeHunk): boolean {
  return (
    a.kind === b.kind &&
    a.originalStartLine === b.originalStartLine &&
    a.originalLineCount === b.originalLineCount
  )
}

function anchorLine(hunk: GitChangeHunk): number {
  return hunk.kind === 'deleted' ? hunk.startLine : hunk.endLine
}

function findHunkAtLine(hunks: readonly GitChangeHunk[], lineNumber: number): GitChangeHunk | null {
  return (
    hunks.find(
      (hunk) =>
        hunk.kind !== 'deleted' && lineNumber >= hunk.startLine && lineNumber <= hunk.endLine
    ) ??
    // The wedge straddles the boundary, so a click on its lower half lands on the next line.
    hunks.find(
      (hunk) =>
        hunk.kind === 'deleted' &&
        (Math.max(1, hunk.startLine) === lineNumber || hunk.startLine + 1 === lineNumber)
    ) ??
    null
  )
}

/** Clicking a gutter mark opens a floating peek with that hunk's baseline lines. */
export function useMonacoGitChangePeek(params: {
  mountedEditor: editor.IStandaloneCodeEditor | null
  hunks: readonly GitChangeHunk[]
  baseline: GitHeadBaseline
}): GitChangePeekModel | null {
  const { mountedEditor, hunks, baseline } = params
  const [target, setTarget] = useState<GitChangeHunk | null>(null)
  const [widget, setWidget] = useState<editor.IContentWidget | null>(null)
  const hunksRef = useRef(hunks)
  hunksRef.current = hunks

  const activeIndex = target ? hunks.findIndex((hunk) => isSameHunk(hunk, target)) : -1
  const active = activeIndex === -1 ? null : hunks[activeIndex]
  const activeAnchorLine = active ? anchorLine(active) : null

  // Why: a kept target would reopen the peek unprompted when undo/redo brings its hunk back.
  if (target !== null && active === null) {
    setTarget(null)
  }

  const hasHunks = hunks.length > 0
  useEffect(() => {
    if (!mountedEditor || !hasHunks) {
      return
    }
    const mouseSub = mountedEditor.onMouseDown((event) => {
      const lineNumber = event.target.position?.lineNumber
      // The fold chevron shares this lane, so the click must land on a mark itself.
      const clicked =
        event.target.type === GUTTER_LINE_DECORATIONS_TARGET &&
        event.target.element?.classList.contains(GUTTER_MARK_CLASS) &&
        event.event.leftButton &&
        lineNumber
          ? findHunkAtLine(hunksRef.current, lineNumber)
          : null
      // Any other click in the editor dismisses the peek; its own clicks never reach Monaco.
      setTarget((current) =>
        clicked && !(current && isSameHunk(current, clicked)) ? clicked : null
      )
    })
    const keySub = mountedEditor.onKeyDown((event) => {
      if (event.browserEvent.key === 'Escape') {
        setTarget(null)
      }
    })
    return () => {
      mouseSub.dispose()
      keySub.dispose()
    }
  }, [mountedEditor, hasHunks])

  useEffect(() => {
    if (!mountedEditor || activeAnchorLine === null) {
      return
    }
    const domNode = document.createElement('div')
    domNode.className = 'orca-git-change-peek-widget'
    mountedEditor.applyFontInfo(domNode)
    // Tabs in the original lines must be as wide as the editor's for indentation to line up.
    domNode.style.tabSize = String(mountedEditor.getModel()?.getOptions().tabSize ?? 4)
    const disposeMouseDownStopper = installDiffCommentZoneMouseDownStopper(domNode)
    // Why a content widget: it floats over the code, where a view zone would push lines apart.
    const contentWidget: editor.IContentWidget = {
      getId: () => PEEK_WIDGET_ID,
      // Lets the popup's border sit on the code's left edge without being clipped by the gutter.
      allowEditorOverflow: true,
      getDomNode: () => domNode,
      getPosition: () => ({
        position: { lineNumber: Math.max(1, activeAnchorLine), column: 1 },
        preference:
          activeAnchorLine === 0 ? [WIDGET_ABOVE, WIDGET_BELOW] : [WIDGET_BELOW, WIDGET_ABOVE]
      })
    }
    mountedEditor.addContentWidget(contentWidget)
    setWidget(contentWidget)
    return () => {
      disposeMouseDownStopper()
      mountedEditor.removeContentWidget(contentWidget)
      setWidget(null)
    }
  }, [mountedEditor, activeAnchorLine])

  const isOpen = active !== null
  useEffect(() => {
    const editorNode = mountedEditor?.getContainerDomNode()
    if (!editorNode || !isOpen) {
      return
    }
    // Clicks inside the editor are the mouse listener's; this covers the rest of the app.
    const closeOnOutsideMouseDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !editorNode.contains(event.target)) {
        setTarget(null)
      }
    }
    document.addEventListener('mousedown', closeOnOutsideMouseDown, true)
    return () => document.removeEventListener('mousedown', closeOnOutsideMouseDown, true)
  }, [mountedEditor, isOpen])

  const showHunkAt = useCallback(
    (index: number): void => {
      const next = hunksRef.current[index]
      if (!next) {
        return
      }
      setTarget(next)
      mountedEditor?.revealLineInCenterIfOutsideViewport(Math.max(1, anchorLine(next)))
    },
    [mountedEditor]
  )

  const originalLines = useMemo(
    () =>
      active && baseline
        ? baseline.slice(
            active.originalStartLine - 1,
            active.originalStartLine - 1 + active.originalLineCount
          )
        : [],
    [active, baseline]
  )

  // `hunks` is a dependency because it changes whenever the buffer lines behind `active` do.
  const inlineDiff = useMemo(() => {
    const model = mountedEditor?.getModel()
    if (!model || !active || active.kind === 'added') {
      return null
    }
    const bufferLines =
      active.kind === 'deleted'
        ? []
        : model.getLinesContent().slice(active.startLine - 1, active.endLine)
    return computeGitChangeInlineDiff(originalLines, bufferLines, active.startLine)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [mountedEditor, active, originalLines, hunks])

  useEffect(() => {
    if (!mountedEditor || !inlineDiff || inlineDiff.insertedRanges.length === 0) {
      return
    }
    const collection = mountedEditor.createDecorationsCollection(
      inlineDiff.insertedRanges.map((range) => ({
        range,
        options: { inlineClassName: 'orca-git-change-peek-inserted' }
      }))
    )
    return () => collection.clear()
  }, [mountedEditor, inlineDiff])

  if (!mountedEditor || !active || !widget) {
    return null
  }
  const total = hunks.length
  return {
    domNode: widget.getDomNode(),
    originalSegments: inlineDiff?.originalSegments ?? [],
    total,
    onPrevious: () => showHunkAt((activeIndex - 1 + total) % total),
    onNext: () => showHunkAt((activeIndex + 1) % total),
    onCopy: () => {
      void window.api.ui.writeClipboardText(originalLines.join('\n')).catch(() => {})
    },
    onRevert: () => {
      const model = mountedEditor.getModel()
      // Why: painted hunks lag edits by the repaint debounce, and a stale range reverts the wrong lines.
      const current = model
        ? computeGitChangeHunks(baseline ?? [], model.getLinesContent())?.find((hunk) =>
            isSameHunk(hunk, active)
          )
        : undefined
      setTarget(null)
      if (!model || !current) {
        return
      }
      const edit = buildGitChangeHunkRevertEdit(current, originalLines, {
        lineCount: model.getLineCount(),
        eol: model.getEOL(),
        getLineMaxColumn: (lineNumber) => model.getLineMaxColumn(lineNumber)
      })
      mountedEditor.pushUndoStop()
      mountedEditor.executeEdits('git-change-revert', [edit])
      mountedEditor.pushUndoStop()
      mountedEditor.focus()
    },
    onClose: () => {
      setTarget(null)
      mountedEditor.focus()
    },
    onContentResize: () => mountedEditor.layoutContentWidget(widget)
  }
}
