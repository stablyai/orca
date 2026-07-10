import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import {
  ClaudeLogo,
  CodexLogo,
  CornerEnterIcon,
  CursorIcon,
  MessageIcon,
  NOTE_TARGETS,
  PlusIcon,
  SendIcon
} from './review-animated-visual-shared'
import { ReviewNotesVisualStyles } from './review-animated-visual-notes-styles'
import { ReviewDiffRows } from './review-notes-diff-rows'
import { resetTerminal, runTerminalPhase } from './review-notes-terminal-phase'
import { translate } from '@/i18n/i18n'

// Why: this visual mirrors the imperative-DOM pattern used by
// EditorAnimatedVisual / WorkbenchAnimatedVisual so the loop reads like the
// reference HTML mock (docs/feature-wall-review-tile-mock.html) instead of
// fighting React reconciliation across timed beats.
export function ReviewNotesAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const root = rootRef.current
    if (!root) {
      return
    }

    const cursorMaybe = root.querySelector<HTMLDivElement>('[data-cursor]')
    const popoverMaybe = root.querySelector<HTMLDivElement>('[data-note-popover]')
    const popInputMaybe = root.querySelector<HTMLDivElement>('[data-pop-input]')
    const popLineMaybe = root.querySelector<HTMLSpanElement>('[data-pop-line]')
    const addBtnMaybe = root.querySelector<HTMLButtonElement>('[data-add-note-btn]')
    const sendChipMaybe = root.querySelector<HTMLSpanElement>('[data-ai-notes-chip]')
    const sendBtnMaybe = root.querySelector<HTMLButtonElement>('[data-send-btn]')
    const sendMenuMaybe = root.querySelector<HTMLDivElement>('[data-send-menu]')
    const aiCountMaybe = root.querySelector<HTMLSpanElement>('[data-ai-count]')
    const diffBodyMaybe = root.querySelector<HTMLDivElement>('[data-diff-body]')
    const diffScrollMaybe = root.querySelector<HTMLDivElement>('[data-diffscroll]')
    const termMaybe = root.querySelector<HTMLDivElement>('[data-term]')
    if (
      !cursorMaybe ||
      !popoverMaybe ||
      !popInputMaybe ||
      !popLineMaybe ||
      !addBtnMaybe ||
      !sendChipMaybe ||
      !sendBtnMaybe ||
      !sendMenuMaybe ||
      !aiCountMaybe ||
      !diffBodyMaybe ||
      !diffScrollMaybe ||
      !termMaybe
    ) {
      return
    }
    // Re-bind to non-null locals so closures across `await` keep their
    // narrowed types — TS flow analysis drops narrowing through async
    // boundaries.
    const rootEl: HTMLDivElement = root
    const cursor: HTMLDivElement = cursorMaybe
    const popover: HTMLDivElement = popoverMaybe
    const popInput: HTMLDivElement = popInputMaybe
    const popLine: HTMLSpanElement = popLineMaybe
    const addBtn: HTMLButtonElement = addBtnMaybe
    const sendChip: HTMLSpanElement = sendChipMaybe
    const sendBtn: HTMLButtonElement = sendBtnMaybe
    const sendMenu: HTMLDivElement = sendMenuMaybe
    const aiCount: HTMLSpanElement = aiCountMaybe
    const diffBody: HTMLDivElement = diffBodyMaybe
    const diffScroll: HTMLDivElement = diffScrollMaybe
    const term: HTMLDivElement = termMaybe

    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => resolve(), ms)
        timers.push(id)
      })

    function findDiffRow(hunk: number, lineIdx: number): HTMLDivElement | null {
      return rootEl.querySelector<HTMLDivElement>(
        `[data-hunk-idx="${hunk}"][data-line-idx="${lineIdx}"]`
      )
    }

    function moveCursor(anchor: HTMLElement, ox = 0, oy = 0): void {
      const pr = rootEl.getBoundingClientRect()
      const ar = anchor.getBoundingClientRect()
      cursor.style.transform = `translate(${ar.left - pr.left + ox}px, ${ar.top - pr.top + oy}px)`
    }

    function anchorAddBtnTo(row: HTMLElement): void {
      const dr = diffBody.getBoundingClientRect()
      const rr = row.getBoundingClientRect()
      const x = rr.left - dr.left + 4
      const y = rr.top - dr.top + (rr.height - 18) / 2
      addBtn.style.left = `${x}px`
      addBtn.style.top = `${y}px`
      addBtn.classList.add('is-visible')
    }

    function anchorPopoverTo(row: HTMLElement): void {
      const dr = diffBody.getBoundingClientRect()
      const rr = row.getBoundingClientRect()
      const popH = popover.offsetHeight || 110
      const spaceBelow = dr.bottom - rr.bottom
      const flipAbove = spaceBelow < popH + 12
      if (flipAbove) {
        const yAbove = rr.top - dr.top - popH - 4
        popover.style.top = `${Math.max(8, yAbove)}px`
      } else {
        popover.style.top = `${rr.bottom - dr.top + 4}px`
      }
    }

    async function fillPopoverInput(text: string): Promise<void> {
      // Why: clear the popover input to a bare typed-span before the cursor
      // lands so the placeholder doesn't flash between the click and the
      // generated note text. Mock: docs/feature-wall-review-tile-mock.html.
      popInput.innerHTML = '<span data-pop-typed></span><span class="ravs-caret"></span>'
      const typed = popInput.querySelector<HTMLSpanElement>('[data-pop-typed]')
      if (!typed) {
        return
      }
      for (const ch of text) {
        if (cancelled) {
          return
        }
        typed.textContent = (typed.textContent ?? '') + ch
        await wait(18)
      }
    }

    function showSavedNote(target: { hunk: number; lineIdx: number; body: string }): void {
      const slot = rootEl.querySelector<HTMLDivElement>(`[data-hunk-slot="${target.hunk}"]`)
      if (!slot) {
        return
      }
      const lineEl = slot.querySelector<HTMLSpanElement>('[data-slot-line]')
      const bodyEl = slot.querySelector<HTMLSpanElement>('[data-slot-body]')
      const row = findDiffRow(target.hunk, target.lineIdx)
      if (row && lineEl) {
        const lns = row.querySelectorAll('.ravs-ln')
        lineEl.textContent = lns[1]?.textContent ?? ''
      }
      if (bodyEl) {
        bodyEl.textContent = target.body
      }
      slot.classList.add('is-visible')
    }

    function resetState(): void {
      rootEl.querySelectorAll('[data-hunk-slot]').forEach((el) => el.classList.remove('is-visible'))
      popover.classList.remove('is-visible')
      // Empty the input so no placeholder flashes between resets.
      popInput.innerHTML = ''
      addBtn.classList.remove('is-visible')
      sendChip.classList.remove('is-visible')
      sendMenu.classList.remove('is-visible')
      sendBtn.classList.remove('is-flash')
      aiCount.textContent = '0'
      diffScroll.classList.remove('is-hidden')
      term.classList.remove('is-visible')
      resetTerminal(term)
      cursor.classList.remove('is-visible', 'is-clicking')
      cursor.style.transition = 'none'
      cursor.style.transform = 'translate(-30px, 220px)'
      void cursor.offsetWidth
      cursor.style.transition = ''
    }

    function getNewLineNo(target: { hunk: number; lineIdx: number }): string {
      const row = findDiffRow(target.hunk, target.lineIdx)
      const lns = row?.querySelectorAll('.ravs-ln')
      return lns?.[1]?.textContent ?? '?'
    }

    async function loop(): Promise<void> {
      while (!cancelled) {
        resetState()
        await wait(520)
        if (cancelled) {
          return
        }

        for (let i = 0; i < NOTE_TARGETS.length; i++) {
          const target = NOTE_TARGETS[i]
          const row = findDiffRow(target.hunk, target.lineIdx)
          if (!row) {
            continue
          }

          cursor.classList.add('is-visible')
          moveCursor(row, -8, 4)
          anchorAddBtnTo(row)
          await wait(700)
          if (cancelled) {
            return
          }

          moveCursor(addBtn, 4, 4)
          await wait(360)
          if (cancelled) {
            return
          }

          cursor.classList.add('is-clicking')
          await wait(220)
          if (cancelled) {
            return
          }
          cursor.classList.remove('is-clicking')
          addBtn.classList.remove('is-visible')
          const lns = row.querySelectorAll('.ravs-ln')
          popLine.textContent = lns[1]?.textContent ?? ''
          // Empty the input before showing the popover so no placeholder
          // flashes between the click and the typed text.
          popInput.innerHTML = ''
          anchorPopoverTo(row)
          popover.classList.add('is-visible')
          moveCursor(popInput, 12, 18)
          await wait(280)
          if (cancelled) {
            return
          }

          await fillPopoverInput(target.body)
          if (cancelled) {
            return
          }
          await wait(360)
          if (cancelled) {
            return
          }

          const addPopBtn = popover.querySelector<HTMLButtonElement>('.ravs-pop-btn.is-add')
          if (addPopBtn) {
            moveCursor(addPopBtn, 30, 10)
          }
          await wait(280)
          if (cancelled) {
            return
          }
          cursor.classList.add('is-clicking')
          await wait(200)
          if (cancelled) {
            return
          }
          cursor.classList.remove('is-clicking')
          popover.classList.remove('is-visible')
          showSavedNote(target)
          aiCount.textContent = String(i + 1)
          if (!sendChip.classList.contains('is-visible')) {
            sendChip.classList.add('is-visible')
          }
          await wait(620)
          if (cancelled) {
            return
          }
        }

        moveCursor(sendBtn, 6, 8)
        await wait(420)
        if (cancelled) {
          return
        }
        cursor.classList.add('is-clicking')
        await wait(200)
        if (cancelled) {
          return
        }
        cursor.classList.remove('is-clicking')
        sendMenu.classList.add('is-visible')
        await wait(420)
        if (cancelled) {
          return
        }

        const claudeRow = sendMenu.querySelector<HTMLDivElement>('[data-send-row="claude"]')
        if (claudeRow) {
          claudeRow.classList.add('is-hot')
          moveCursor(claudeRow, 24, 10)
        }
        await wait(540)
        if (cancelled) {
          return
        }
        cursor.classList.add('is-clicking')
        await wait(220)
        if (cancelled) {
          return
        }
        cursor.classList.remove('is-clicking')
        if (claudeRow) {
          claudeRow.classList.remove('is-hot')
        }
        sendMenu.classList.remove('is-visible')
        sendBtn.classList.add('is-flash')
        await wait(560)
        if (cancelled) {
          return
        }
        sendBtn.classList.remove('is-flash')
        cursor.classList.remove('is-visible')

        await runTerminalPhase({
          term,
          diffScroll,
          wait,
          isCancelled: () => cancelled,
          getNewLineNo
        })
        if (cancelled) {
          return
        }

        await wait(800)
        if (cancelled) {
          return
        }
      }
    }

    void loop()

    return () => {
      cancelled = true
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [reducedMotion])

  return (
    <div ref={rootRef} className="ravs-window" data-page="notes">
      <div className="ravs-difftoolbar">
        <span className="ravs-diff-path">
          {translate(
            'auto.components.feature.wall.ReviewNotesAnimatedVisual.1eee3a397e',
            'src/server/migrate.ts (diff)'
          )}
        </span>
        <span className="ravs-ai-chip" data-ai-notes-chip>
          <button type="button" className="ravs-count-btn">
            <MessageIcon />{' '}
            {translate(
              'auto.components.feature.wall.ReviewNotesAnimatedVisual.5cb213f967',
              'AI notes'
            )}{' '}
            <span className="ravs-count-num" data-ai-count>
              0
            </span>
          </button>
          <button type="button" className="ravs-send-btn" data-send-btn>
            <SendIcon />
            <span className="ravs-send-glow" />
          </button>
        </span>
      </div>
      <div className="ravs-diffbody" data-diff-body>
        <div className="ravs-diffscroll" data-diffscroll>
          <ReviewDiffRows />
        </div>
        <div className="ravs-term" data-term aria-hidden>
          <div className="ravs-term-body">
            <div className="ravs-term-line ravs-term-muted" data-term-line-start />
            <div className="ravs-term-line" data-term-line-loaded />
            <div className="ravs-term-line" data-term-line-ack-0 />
            <div className="ravs-term-line" data-term-line-ack-1 />
            <div className="ravs-term-line" data-term-line-tail />
          </div>
        </div>
        <button className="ravs-add-note-btn" data-add-note-btn aria-hidden type="button">
          <PlusIcon />
        </button>
        <div className="ravs-popover" data-note-popover>
          <div className="ravs-pop-label">
            {translate('auto.components.feature.wall.ReviewNotesAnimatedVisual.a7a89d8f94', 'Line')}
            <span data-pop-line>?</span>
          </div>
          <div className="ravs-pop-input" data-pop-input />
          <div className="ravs-pop-footer">
            <button type="button" className="ravs-pop-btn is-cancel">
              {translate(
                'auto.components.feature.wall.ReviewNotesAnimatedVisual.271ea0cbf3',
                'Cancel'
              )}
            </button>
            <button type="button" className="ravs-pop-btn is-add">
              {translate(
                'auto.components.feature.wall.ReviewNotesAnimatedVisual.ea4e45b71b',
                'Add note'
              )}
              <CornerEnterIcon />
            </button>
          </div>
        </div>
        <div className="ravs-send-menu" data-send-menu>
          <div className="ravs-menu-section">
            {translate(
              'auto.components.feature.wall.ReviewNotesAnimatedVisual.294aaff104',
              'Send notes to'
            )}
          </div>
          <div className="ravs-menu-row" data-send-row="claude">
            <ClaudeLogo />
            <span>
              {translate(
                'auto.components.feature.wall.ReviewNotesAnimatedVisual.09094f25e2',
                'Claude Code'
              )}
            </span>
          </div>
          <div className="ravs-menu-row" data-send-row="codex">
            <CodexLogo />
            <span>
              {translate(
                'auto.components.feature.wall.ReviewNotesAnimatedVisual.5dbd27c4c2',
                'Codex'
              )}
            </span>
          </div>
        </div>
      </div>
      <div className="ravs-cursor" data-cursor>
        <CursorIcon />
        <span className="ravs-ripple" />
      </div>
      <ReviewNotesVisualStyles />
    </div>
  )
}
