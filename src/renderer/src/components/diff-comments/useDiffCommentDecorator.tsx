import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { editor as monacoEditor, IDisposable } from 'monaco-editor'
import { createRoot, type Root } from 'react-dom/client'
import type { DiffComment } from '../../../../shared/types'
import { DiffCommentCard } from './DiffCommentCard'

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

type ZoneEntry = {
  zoneId: string
  domNode: HTMLElement
  root: Root
  lastBody: string
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
  // Why: one React root per view zone. Body updates re-render into the
  // existing root, so Monaco's zone DOM stays in place and only the card
  // contents update — matching the diff-based pass that replaced the previous
  // hand-built DOM implementation.
  const zonesRef = useRef<Map<string, ZoneEntry>>(new Map())
  const disposablesRef = useRef<IDisposable[]>([])
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
    plus.title = 'Add note for the AI'
    plus.setAttribute('aria-label', 'Add note for the AI')
    plus.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'
    plus.style.display = 'none'
    editorDomNode.appendChild(plus)

    const getLineHeight = (): number => {
      const h = editor.getOption(monaco.editor.EditorOption.lineHeight)
      return typeof h === 'number' && h > 0 ? h : 19
    }

    // Why: cache last-applied style values so positionAtLine skips redundant
    // DOM writes during mousemove. Monaco's onMouseMove fires at high
    // frequency, and every style assignment to an element currently under the
    // cursor can retrigger hover state and cause flicker.
    let lastTop: number | null = null
    let lastDisplay: string | null = null

    const setDisplay = (value: string): void => {
      if (lastDisplay === value) {
        return
      }
      plus.style.display = value
      lastDisplay = value
    }

    // Why: keep the button a fixed 18px square (height set in CSS) and
    // vertically center it within the hovered line's box. Previously the
    // height tracked the line height, producing a rectangle on editors with
    // taller line-heights. Centering relative to lineHeight keeps the button
    // sitting neatly on whatever line the cursor is on.
    const BUTTON_SIZE = 18
    const positionAtLine = (lineNumber: number): void => {
      const lineTop = editor.getTopForLineNumber(lineNumber) - editor.getScrollTop()
      const top = Math.round(lineTop + (getLineHeight() - BUTTON_SIZE) / 2)
      if (top !== lastTop) {
        plus.style.top = `${top}px`
        lastTop = top
      }
      setDisplay('flex')
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
      // Why: Monaco reports null position when the cursor is over overlay DOM
      // that sits inside the editor — including our own "+" button. Hiding on
      // null would create a flicker loop: cursor enters button → null → hide
      // → cursor is now over line text → show → repeat. Keep the button
      // visible at its last line while the cursor is on it. The onMouseLeave
      // handler still hides it when the cursor leaves the editor entirely.
      const srcEvent = e.event?.browserEvent as MouseEvent | undefined
      if (srcEvent && plus.contains(srcEvent.target as Node)) {
        return
      }
      const ln = e.target.position?.lineNumber ?? null
      if (ln == null) {
        setDisplay('none')
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
      setDisplay('none')
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
      // it. Unmount the React roots and clear tracking so a subsequent editor
      // mount starts from a known-empty state rather than trying to remove
      // stale zone ids from a dead editor. The diff effect below deliberately
      // has no cleanup so comment-only changes don't cause a full zone
      // rebuild; this cleanup is the single place we reset zone tracking.
      for (const entry of zonesRef.current.values()) {
        entry.root.unmount()
      }
      zonesRef.current.clear()
    }
  }, [editor])

  useEffect(() => {
    if (!editor) {
      return
    }

    const relevant = comments.filter((c) => c.filePath === filePath && c.worktreeId === worktreeId)
    const relevantMap = new Map(relevant.map((c) => [c.id, c] as const))

    const zones = zonesRef.current
    // Why: unmounting a React root inside Monaco's changeViewZones callback
    // triggers synchronous DOM mutations that Monaco isn't expecting mid-flush
    // and can race with its zone bookkeeping. Collect roots to unmount, run
    // the Monaco batch, then unmount afterwards.
    const rootsToUnmount: Root[] = []

    editor.changeViewZones((accessor) => {
      // Why: remove only the zones whose comments are gone. Rebuilding all
      // zones on every change caused flicker and dropped focus/selection in
      // adjacent UI; a diff-based pass keeps the untouched cards stable.
      for (const [commentId, entry] of zones) {
        if (!relevantMap.has(commentId)) {
          accessor.removeZone(entry.zoneId)
          rootsToUnmount.push(entry.root)
          zones.delete(commentId)
        }
      }

      // Add zones for newly-added comments.
      for (const c of relevant) {
        if (zones.has(c.id)) {
          continue
        }
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'
        // Why: swallow mousedown on the whole zone so the editor does not
        // steal focus (or start a selection drag) when the user interacts
        // with anything inside the card. Delete still fires because click is
        // attached directly on the button.
        dom.addEventListener('mousedown', (ev) => ev.stopPropagation())

        const root = createRoot(dom)
        root.render(
          <DiffCommentCard
            lineNumber={c.lineNumber}
            body={c.body}
            onDelete={() => onDeleteCommentRef.current(c.id)}
          />
        )

        // Why: estimate height from line count so the zone is close to the
        // right size on first paint. Monaco sets heightInPx authoritatively at
        // insertion and does not re-measure the DOM node, so an underestimate
        // lets the card bleed into the following editor line. The constant
        // covers fixed chrome (inline wrapper padding ~10, card border 2, card
        // padding 12, header+meta ~22, trailing breathing room) and the
        // per-line factor matches the 12px/1.4 body line-height. If you tweak
        // the card's padding/header sizing, re-tune these numbers in lockstep
        // or the zone will clip again.
        const lineCount = c.body.split('\n').length
        const heightInPx = Math.max(72, 52 + lineCount * 18)

        // Why: suppressMouseDown: false so clicks inside the zone (Delete
        // button) reach our DOM listeners. With true, Monaco intercepts the
        // mousedown and routes it to the editor, so the Delete button never
        // fires. The delete/body mousedown listeners stopPropagation so the
        // editor still doesn't steal focus on interaction.
        const zoneId = accessor.addZone({
          afterLineNumber: c.lineNumber,
          heightInPx,
          domNode: dom,
          suppressMouseDown: false
        })
        zones.set(c.id, { zoneId, domNode: dom, root, lastBody: c.body })
      }

      // Patch existing zones whose body text changed in place — re-render the
      // same root with new props instead of removing/re-adding the zone.
      for (const c of relevant) {
        const entry = zones.get(c.id)
        if (!entry) {
          continue
        }
        if (entry.lastBody === c.body) {
          continue
        }
        entry.root.render(
          <DiffCommentCard
            lineNumber={c.lineNumber}
            body={c.body}
            onDelete={() => onDeleteCommentRef.current(c.id)}
          />
        )
        entry.lastBody = c.body
      }
    })

    // Why: deferred unmount so Monaco has finished its zone batch before we
    // tear down the React trees that were inside those zones.
    if (rootsToUnmount.length > 0) {
      queueMicrotask(() => {
        for (const root of rootsToUnmount) {
          root.unmount()
        }
      })
    }
    // Why: intentionally no cleanup. React would run cleanup BEFORE the next
    // effect body on every `comments` identity change, wiping all zones and
    // forcing a full rebuild — exactly the flicker this diff-based pass is
    // meant to avoid. Zone teardown lives in the editor-scoped effect above,
    // which only fires when the editor itself is replaced/unmounted.
  }, [editor, filePath, worktreeId, comments])
}
