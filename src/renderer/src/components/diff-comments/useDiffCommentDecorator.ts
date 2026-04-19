import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { editor as monacoEditor, IDisposable } from 'monaco-editor'
import type { DiffComment } from '../../../../shared/types'

// Why: Monaco glyph-margin *decorations* don't expose click events in a way
// that lets us show a polished popover anchored to a line. So instead we own a
// single absolutely-positioned "+" button inside the editor DOM node, and we
// move it to follow the mouse-hovered line. Clicking calls the consumer which
// opens a React popover. This keeps all interactive UI as React/DOM rather
// than Monaco decorations, and we get pixel-accurate positioning via Monaco's
// getTopForLineNumber.

type DecoratorArgs = {
  editor: monacoEditor.ICodeEditor | null
  filePath: string
  worktreeId: string
  comments: DiffComment[]
  onAddCommentClick: (args: { lineNumber: number; top: number }) => void
  onDeleteComment: (commentId: string) => void
}

export function useDiffCommentDecorator({
  editor,
  filePath,
  worktreeId,
  comments,
  onAddCommentClick,
  onDeleteComment
}: DecoratorArgs): void {
  const hoverLineRef = useRef<number | null>(null)
  const viewZoneIdsRef = useRef<Map<string, string>>(new Map())
  const disposablesRef = useRef<IDisposable[]>([])
  // Why: cache each comment's rendered DOM node and last-applied body so the
  // view-zone effect can patch an existing card in place when only the body
  // changed, rather than removing and re-adding every zone on each render.
  // Rebuilding all zones caused visible flicker and wasted DOM work whenever
  // a single comment was added, edited, or deleted.
  const domNodesByCommentIdRef = useRef<Map<string, HTMLElement>>(new Map())
  const bodyByCommentIdRef = useRef<Map<string, string>>(new Map())
  // Why: stash the consumer callbacks in refs so the decorator effect's
  // cleanup does not run on every parent render. The parent passes inline
  // arrow functions; without this, each render would tear down and re-attach
  // the "+" button and all view zones, producing visible flicker.
  const onAddCommentClickRef = useRef(onAddCommentClick)
  const onDeleteCommentRef = useRef(onDeleteComment)
  onAddCommentClickRef.current = onAddCommentClick
  onDeleteCommentRef.current = onDeleteComment

  useEffect(() => {
    if (!editor) {
      return
    }

    const editorDomNode = editor.getDomNode()
    if (!editorDomNode) {
      return
    }

    const plus = document.createElement('button')
    plus.type = 'button'
    plus.className = 'orca-diff-comment-add-btn'
    plus.title = 'Add comment for the AI'
    plus.setAttribute('aria-label', 'Add comment for the AI')
    plus.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'
    plus.style.display = 'none'
    editorDomNode.appendChild(plus)

    const getLineHeight = (): number => {
      const h = editor.getOption(monaco.editor.EditorOption.lineHeight)
      return typeof h === 'number' && h > 0 ? h : 19
    }

    const positionAtLine = (lineNumber: number): void => {
      const top = editor.getTopForLineNumber(lineNumber) - editor.getScrollTop()
      plus.style.top = `${top}px`
      plus.style.height = `${getLineHeight()}px`
      plus.style.display = 'flex'
    }

    const handleClick = (ev: MouseEvent): void => {
      ev.preventDefault()
      ev.stopPropagation()
      const ln = hoverLineRef.current
      if (ln == null) {
        return
      }
      const top = editor.getTopForLineNumber(ln) - editor.getScrollTop()
      onAddCommentClickRef.current({ lineNumber: ln, top })
    }
    plus.addEventListener('mousedown', (ev) => ev.stopPropagation())
    plus.addEventListener('click', handleClick)

    const onMouseMove = editor.onMouseMove((e) => {
      const ln = e.target.position?.lineNumber ?? null
      if (ln == null) {
        plus.style.display = 'none'
        return
      }
      hoverLineRef.current = ln
      positionAtLine(ln)
    })
    // Why: only hide the button on mouse-leave; keep hoverLineRef so that a
    // click which lands on the button (possible during the brief window after
    // Monaco's content area reports leave but before the button element does)
    // still resolves to the last-hovered line instead of silently dropping.
    const onMouseLeave = editor.onMouseLeave(() => {
      plus.style.display = 'none'
    })
    const onScroll = editor.onDidScrollChange(() => {
      if (hoverLineRef.current != null) {
        positionAtLine(hoverLineRef.current)
      }
    })

    disposablesRef.current = [onMouseMove, onMouseLeave, onScroll]

    return () => {
      for (const d of disposablesRef.current) {
        d.dispose()
      }
      disposablesRef.current = []
      plus.removeEventListener('click', handleClick)
      plus.remove()
      // Why: when the editor is swapped or torn down, its view zones go with
      // it. Clear the tracking Maps so a subsequent editor mount starts from
      // a known-empty state rather than trying to remove stale zone ids from
      // a dead editor. The diff effect below deliberately has no cleanup so
      // comment-only changes don't cause a full zone rebuild; this cleanup
      // is the single place we reset zone tracking.
      viewZoneIdsRef.current.clear()
      domNodesByCommentIdRef.current.clear()
      bodyByCommentIdRef.current.clear()
    }
  }, [editor])

  useEffect(() => {
    if (!editor) {
      return
    }

    const relevant = comments.filter((c) => c.filePath === filePath && c.worktreeId === worktreeId)
    const relevantMap = new Map(relevant.map((c) => [c.id, c] as const))

    const currentIds = viewZoneIdsRef.current
    const domNodesByCommentId = domNodesByCommentIdRef.current
    const bodyByCommentId = bodyByCommentIdRef.current

    editor.changeViewZones((accessor) => {
      // Why: remove only the zones whose comments are gone. Rebuilding all
      // zones on every change caused flicker and dropped focus/selection in
      // adjacent UI; a diff-based pass keeps the untouched cards stable.
      for (const [commentId, zoneId] of currentIds) {
        if (!relevantMap.has(commentId)) {
          accessor.removeZone(zoneId)
          currentIds.delete(commentId)
          domNodesByCommentId.delete(commentId)
          bodyByCommentId.delete(commentId)
        }
      }

      // Add zones for newly-added comments.
      for (const c of relevant) {
        if (currentIds.has(c.id)) {
          continue
        }
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'

        const card = document.createElement('div')
        card.className = 'orca-diff-comment-card'

        const header = document.createElement('div')
        header.className = 'orca-diff-comment-header'
        const meta = document.createElement('span')
        meta.className = 'orca-diff-comment-meta'
        meta.textContent = `Comment · line ${c.lineNumber}`
        const del = document.createElement('button')
        del.type = 'button'
        del.className = 'orca-diff-comment-delete'
        del.title = 'Delete comment'
        del.textContent = 'Delete'
        del.addEventListener('mousedown', (ev) => ev.stopPropagation())
        del.addEventListener('click', (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          onDeleteCommentRef.current(c.id)
        })
        header.appendChild(meta)
        header.appendChild(del)

        const body = document.createElement('div')
        body.className = 'orca-diff-comment-body'
        body.textContent = c.body

        card.appendChild(header)
        card.appendChild(body)
        dom.appendChild(card)

        // Why: estimate height from line count so the zone is close to the
        // right size on first paint. Monaco sets heightInPx authoritatively at
        // insertion and does not re-measure the DOM node, so a fixed 72 clipped
        // multi-line bodies. The per-line estimate handles typical review
        // notes without needing a post-attach measurement pass.
        const lineCount = c.body.split('\n').length
        const heightInPx = Math.max(56, 28 + lineCount * 18)

        const id = accessor.addZone({
          afterLineNumber: c.lineNumber,
          heightInPx,
          domNode: dom,
          suppressMouseDown: true
        })
        currentIds.set(c.id, id)
        domNodesByCommentId.set(c.id, dom)
        bodyByCommentId.set(c.id, c.body)
      }

      // Patch existing zones whose body text changed in place — avoids the
      // full rebuild that would otherwise flicker the card.
      for (const c of relevant) {
        if (!currentIds.has(c.id)) {
          continue
        }
        const previousBody = bodyByCommentId.get(c.id)
        if (previousBody === c.body) {
          continue
        }
        const dom = domNodesByCommentId.get(c.id)
        if (!dom) {
          continue
        }
        const bodyEl = dom.querySelector('.orca-diff-comment-body')
        if (bodyEl) {
          bodyEl.textContent = c.body
        }
        bodyByCommentId.set(c.id, c.body)
      }
    })
    // Why: intentionally no cleanup. React would run cleanup BEFORE the next
    // effect body on every `comments` identity change, wiping all zones and
    // forcing a full rebuild — exactly the flicker this diff-based pass is
    // meant to avoid. Zone teardown lives in the editor-scoped effect above,
    // which only fires when the editor itself is replaced/unmounted.
  }, [editor, filePath, worktreeId, comments])
}
