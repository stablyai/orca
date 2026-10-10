import { useEffect } from 'react'
import {
  EDITOR_ANIMATION_TIMING,
  activeLineClass,
  caretClass,
  codeBlockHTML,
  type EditorAnimatedVisualRefs
} from './editor-animated-visual-markup'

export function useEditorAnimatedVisualAnimation(
  reducedMotion: boolean,
  refs: EditorAnimatedVisualRefs
): void {
  const {
    docRef,
    activeLineRef,
    activeTextRef,
    afterRef,
    cursorRef,
    menuRef,
    rowH1Ref,
    rowCodeRef
  } = refs
  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const docMaybe = docRef.current
    const activeLineInitial = activeLineRef.current
    const cursorMaybe = cursorRef.current
    const menuMaybe = menuRef.current
    const afterMaybe = afterRef.current
    if (!docMaybe || !activeLineInitial || !cursorMaybe || !menuMaybe || !afterMaybe) {
      return
    }
    // Re-bind to non-null locals so the helper closures spanning `await`
    // points keep their narrowed types — TS flow analysis drops the narrow
    // through async boundaries otherwise.
    const doc: HTMLDivElement = docMaybe
    const cursor: HTMLDivElement = cursorMaybe
    const menu: HTMLDivElement = menuMaybe
    const after: HTMLDivElement = afterMaybe

    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => resolve(), ms)
        timers.push(id)
      })

    // Stash initial DOM so we can restore between loops.
    const initialActiveLineHTML = activeLineInitial.outerHTML
    const initialActiveLineParent = activeLineInitial.parentNode
    const initialActiveLineNextSibling = activeLineInitial.nextSibling

    let activeLine: HTMLDivElement = activeLineInitial
    let activeText: HTMLSpanElement | null = activeTextRef.current
    let activeCaret: HTMLSpanElement | null =
      activeLineInitial.querySelector<HTMLSpanElement>('[data-md-caret]')

    function setSlashMode(mode: 'all' | 'code'): void {
      menu.querySelectorAll<HTMLElement>('[data-slash-show]').forEach((el) => {
        const allowed = (el.getAttribute('data-slash-show') ?? '').split(',')
        el.style.display = allowed.includes(mode) ? '' : 'none'
      })
    }

    function placeMenuNearLine(line: HTMLElement): void {
      const docRect = doc.getBoundingClientRect()
      const lineRect = line.getBoundingClientRect()
      // Why: nudge the menu right so it doesn't cover the "/" the user just
      // typed — keeps the typed character visible alongside the menu.
      const x = lineRect.left - docRect.left + 16
      menu.style.left = `${x}px`
      menu.style.top = '0px'
      const wasShown = menu.dataset.shown === '1'
      if (!wasShown) {
        menu.style.visibility = 'hidden'
        menu.dataset.shown = '1'
        menu.style.opacity = '1'
        menu.style.transform = 'none'
      }
      const menuH = menu.getBoundingClientRect().height
      if (!wasShown) {
        menu.dataset.shown = ''
        menu.style.opacity = ''
        menu.style.transform = ''
        menu.style.visibility = ''
      }
      const belowY = lineRect.bottom - docRect.top + 6
      const aboveY = lineRect.top - docRect.top - menuH - 6
      const docH = docRect.height
      const fitsBelow = belowY + menuH <= docH - 4
      menu.style.top = `${fitsBelow ? belowY : Math.max(4, aboveY)}px`
    }

    function moveCursorTo(targetEl: HTMLElement, offsetX = 0, offsetY = 0): void {
      const docRect = doc.getBoundingClientRect()
      const tRect = targetEl.getBoundingClientRect()
      const x = tRect.left - docRect.left + offsetX
      const y = tRect.top - docRect.top + offsetY
      cursor.style.transform = `translate(${x}px, ${y}px)`
    }

    function showMenu(): void {
      menu.dataset.shown = '1'
      menu.style.opacity = '1'
      menu.style.transform = 'translateY(0) scale(1)'
    }
    function hideMenu(): void {
      menu.dataset.shown = ''
      menu.style.opacity = '0'
      menu.style.transform = 'translateY(-4px) scale(0.985)'
    }
    function clearActiveRow(): void {
      menu
        .querySelectorAll<HTMLElement>('[data-slash-row]')
        .forEach((el) => el.classList.remove('slash-active'))
    }

    async function typeInto(
      el: HTMLElement,
      text: string,
      perChar: number = EDITOR_ANIMATION_TIMING.typePerCharMs
    ): Promise<void> {
      for (const ch of text) {
        if (cancelled) {
          return
        }
        el.textContent = (el.textContent ?? '') + ch
        await wait(perChar)
      }
    }

    function clearAfter(): void {
      after.innerHTML = ''
    }

    function restoreInitialActiveLine(): void {
      // Pull whatever the active line currently is back into the original
      // shape so the next loop starts from the same DOM as render.
      activeLine.remove()
      const wrapper = document.createElement('div')
      wrapper.innerHTML = initialActiveLineHTML
      const fresh = wrapper.firstElementChild as HTMLDivElement | null
      if (!fresh) {
        return
      }
      if (initialActiveLineParent) {
        if (
          initialActiveLineNextSibling &&
          initialActiveLineNextSibling.parentNode === initialActiveLineParent
        ) {
          initialActiveLineParent.insertBefore(fresh, initialActiveLineNextSibling)
        } else {
          initialActiveLineParent.appendChild(fresh)
        }
      }
      activeLine = fresh
      activeText = fresh.querySelector<HTMLSpanElement>('[data-md-active-text]')
      activeCaret = fresh.querySelector<HTMLSpanElement>('[data-md-caret]')
    }

    async function loop(): Promise<void> {
      while (!cancelled) {
        // Reset state.
        clearAfter()
        hideMenu()
        clearActiveRow()
        cursor.style.transition = 'none'
        cursor.style.opacity = '0'
        cursor.style.transform = 'translate(-30px, 80px)'
        // Force reflow so the next transition takes effect.
        void cursor.offsetWidth
        cursor.style.transition = ''
        await wait(EDITOR_ANIMATION_TIMING.preHoverMs)
        if (cancelled) {
          return
        }

        // 1. Type "/" on the fresh active line.
        if (activeText) {
          activeText.textContent = ''
        }
        await typeInto(activeText ?? activeLine, '/')
        if (cancelled) {
          return
        }
        await wait(EDITOR_ANIMATION_TIMING.postTypeMs)
        if (cancelled) {
          return
        }

        // 2. Slash menu opens, anchored near the line.
        setSlashMode('all')
        placeMenuNearLine(activeLine)
        showMenu()
        cursor.style.opacity = '1'
        const rowH1 = rowH1Ref.current
        if (rowH1) {
          moveCursorTo(rowH1, 14, 11)
          rowH1.classList.add('slash-active')
        }
        await wait(EDITOR_ANIMATION_TIMING.menuHoldMs)
        if (cancelled) {
          return
        }

        // 3. Click — line becomes an H1.
        cursor.dataset.clicking = '1'
        await wait(EDITOR_ANIMATION_TIMING.clickRippleMs)
        if (cancelled) {
          return
        }
        cursor.dataset.clicking = ''
        hideMenu()
        cursor.style.opacity = '0'
        await wait(EDITOR_ANIMATION_TIMING.postClickMs)
        if (cancelled) {
          return
        }

        // Convert the active line to an H1: clear the slash glyph, drop the
        // monospace styling, type the heading.
        activeLine.dataset.role = 'h1'
        if (activeText) {
          activeText.textContent = ''
        }
        if (activeCaret) {
          activeCaret.style.display = ''
        }
        await wait(EDITOR_ANIMATION_TIMING.postH1RevealMs)
        if (cancelled) {
          return
        }
        await typeInto(activeText ?? activeLine, 'Ship checklist', 55)
        if (cancelled) {
          return
        }
        await wait(EDITOR_ANIMATION_TIMING.postH1TypeMs)
        if (cancelled) {
          return
        }

        // 4. New active line below the H1 — user types "/code".
        const newActive = document.createElement('div')
        newActive.dataset.role = 'active'
        newActive.className = activeLineClass()
        const newText = document.createElement('span')
        newText.dataset.mdActiveText = '1'
        const newCaret = document.createElement('span')
        newCaret.dataset.mdCaret = '1'
        newCaret.className = caretClass()
        newActive.appendChild(newText)
        newActive.appendChild(newCaret)
        after.appendChild(newActive)
        const lineForBeat2 = newActive
        await wait(EDITOR_ANIMATION_TIMING.newLineHoldMs)
        if (cancelled) {
          return
        }

        for (const ch of '/code') {
          if (cancelled) {
            return
          }
          newText.textContent = (newText.textContent ?? '') + ch
          await wait(EDITOR_ANIMATION_TIMING.typePerCharMs)
        }
        await wait(EDITOR_ANIMATION_TIMING.postTypeMs)
        if (cancelled) {
          return
        }

        // Filter to the Code Block row, anchor menu, highlight.
        clearActiveRow()
        if (rowH1) {
          rowH1.classList.remove('slash-active')
        }
        setSlashMode('code')
        placeMenuNearLine(lineForBeat2)
        showMenu()
        cursor.style.opacity = '1'
        const rowCode = rowCodeRef.current
        if (rowCode) {
          moveCursorTo(rowCode, 14, 11)
          rowCode.classList.add('slash-active')
        }
        await wait(EDITOR_ANIMATION_TIMING.menuHoldMs)
        if (cancelled) {
          return
        }

        // 5. Click — line becomes a code block.
        cursor.dataset.clicking = '1'
        await wait(EDITOR_ANIMATION_TIMING.clickRippleMs)
        if (cancelled) {
          return
        }
        cursor.dataset.clicking = ''
        hideMenu()
        cursor.style.opacity = '0'
        await wait(EDITOR_ANIMATION_TIMING.postClickMs)
        if (cancelled) {
          return
        }

        const codeBlock = document.createElement('div')
        codeBlock.className = 'mt-1.5 animate-[md-block-in_380ms_cubic-bezier(.2,.8,.2,1)_both]'
        codeBlock.innerHTML = codeBlockHTML()
        lineForBeat2.replaceWith(codeBlock)

        await wait(EDITOR_ANIMATION_TIMING.finalHoldMs)
        if (cancelled) {
          return
        }

        // Restore the initial DOM and loop.
        restoreInitialActiveLine()
      }
    }

    void loop()
    return () => {
      cancelled = true
      timers.forEach((id) => window.clearTimeout(id))
    }
  }, [
    activeLineRef,
    activeTextRef,
    afterRef,
    cursorRef,
    docRef,
    menuRef,
    reducedMotion,
    rowCodeRef,
    rowH1Ref
  ])
}
