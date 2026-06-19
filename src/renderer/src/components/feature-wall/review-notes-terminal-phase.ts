import { NOTE_TARGETS } from './review-animated-visual-shared'

// Why: terminal-phase logic for the Notes panel lives here so the imperative
// loop in ReviewNotesAnimatedVisual stays under the per-file lint cap. The
// caller passes the live DOM nodes plus a `wait` + `cancelled` getter so
// these helpers can interleave with the rest of the loop's beats.
//
// Mirrors docs/feature-wall-review-tile-mock.html: the panel auto-starts a
// Claude Code session (no `$ claude` command, no typed prompt), shows
// "Loaded N review notes from Orca", lists each ack with its line number,
// and ends on "Fixing both issues..." with a spinner.
export type TerminalPhaseContext = {
  term: HTMLDivElement
  diffScroll: HTMLDivElement
  wait: (ms: number) => Promise<void>
  isCancelled: () => boolean
  getNewLineNo: (target: { hunk: number; lineIdx: number }) => string
}

export function resetTerminal(term: HTMLDivElement): void {
  setLineHTML(term, '[data-term-line-start]', '')
  setLineHTML(term, '[data-term-line-loaded]', '')
  setLineHTML(term, '[data-term-line-ack-0]', '')
  setLineHTML(term, '[data-term-line-ack-1]', '')
  setLineHTML(term, '[data-term-line-tail]', '')
}

function setLineHTML(term: HTMLDivElement, selector: string, html: string): void {
  const el = term.querySelector<HTMLDivElement>(selector)
  if (el) {
    el.innerHTML = html
  }
}

async function typeInto(
  ctx: TerminalPhaseContext,
  selector: string,
  text: string,
  perChar = 14
): Promise<void> {
  const el = ctx.term.querySelector<HTMLElement>(selector)
  if (!el) {
    return
  }
  for (const ch of text) {
    if (ctx.isCancelled()) {
      return
    }
    el.textContent = (el.textContent ?? '') + ch
    await ctx.wait(perChar)
  }
}

export async function runTerminalPhase(ctx: TerminalPhaseContext): Promise<void> {
  const { term, diffScroll, wait, isCancelled } = ctx
  diffScroll.classList.add('is-hidden')
  term.classList.add('is-visible')
  await wait(280)
  if (isCancelled()) {
    return
  }
  const startEl = term.querySelector<HTMLDivElement>('[data-term-line-start]')
  if (startEl) {
    startEl.innerHTML = '<span class="ravs-term-muted">● Claude Code session started</span>'
  }
  await wait(520)
  if (isCancelled()) {
    return
  }
  const loadedEl = term.querySelector<HTMLDivElement>('[data-term-line-loaded]')
  if (loadedEl) {
    loadedEl.innerHTML = `<span class="ravs-term-check">✓</span><span class="ravs-term-muted">Loaded ${NOTE_TARGETS.length} review notes from Orca</span>`
  }
  await wait(520)
  if (isCancelled()) {
    return
  }
  for (let i = 0; i < NOTE_TARGETS.length && i < 2; i++) {
    const target = NOTE_TARGETS[i]
    const lineNo = ctx.getNewLineNo(target)
    const ackSelector = i === 0 ? '[data-term-line-ack-0]' : '[data-term-line-ack-1]'
    const ackEl = term.querySelector<HTMLDivElement>(ackSelector)
    if (ackEl) {
      ackEl.innerHTML = `  <span class="ravs-term-glyph">•</span><span class="ravs-term-muted">line ${lineNo}</span> ${target.summary}`
      await wait(360)
      if (isCancelled()) {
        return
      }
    }
  }
  const tail = term.querySelector<HTMLDivElement>('[data-term-line-tail]')
  if (tail) {
    tail.innerHTML =
      '<span class="ravs-term-spinner" aria-hidden="true"></span><span class="ravs-term-muted" data-term-tail-text></span>'
  }
  await typeInto(ctx, '[data-term-tail-text]', 'Fixing both issues...', 14)
  if (isCancelled()) {
    return
  }
  await wait(3200)
}
