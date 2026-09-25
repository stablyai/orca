import type { Page } from '@stablyai/playwright-test'

/**
 * Samples the colours the browser actually resolves for the rendered composition tail.
 *
 * The overlay sets one colour for everything it draws, which is right for the preedit and for a
 * default cell. A cell that carried its own attributes has to override it, and only a computed
 * style says whether it did — `textContent` is identical either way, and a DOM emulator resolves
 * no inherited colour at all, so a unit-level arm cannot tell a styled run from a bare one.
 *
 * `maskedVisibility` is sampled alongside, because Orca's composer-placeholder mask hides the
 * whole tail for a row it recognises. A row this probe is pointed at must NOT be one of those, or
 * the sample says nothing about painting.
 */
export type PreeditTailPaintSample = {
  found: boolean
  /** Row text from the cursor rightwards — the committed cells the tail reproduces. */
  rowTailFromCursor: string
  text: string
  /** `visible` unless the composer-placeholder mask claimed this row. */
  maskedVisibility: string | null
  /** The overlay's own resolved colour: what every tail cell was painted in before the fix. */
  viewColor: string
  nodes: PreeditTailNode[]
}

export type PreeditTailNode = {
  text: string
  /** True when the tail emitted a span for this stretch rather than a bare inheriting text node. */
  styled: boolean
  color: string
  backgroundColor: string
  fontWeight: string
  fontStyle: string
}

function readPreeditTailPaint(): PreeditTailPaintSample {
  const textarea =
    document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus') ??
    document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
  const view = textarea?.parentElement?.querySelector<HTMLElement>('.composition-view') ?? null
  const remainder = view?.querySelector<HTMLElement>('.xterm-composition-remainder') ?? null
  const empty: PreeditTailPaintSample = {
    found: false,
    rowTailFromCursor: '',
    text: '',
    maskedVisibility: null,
    viewColor: '',
    nodes: []
  }
  if (!view) {
    return empty
  }
  const viewColor = getComputedStyle(view).color

  const state = window.__store?.getState()
  const worktreeId = state?.activeWorktreeId
  const tabId =
    state?.activeTabType === 'terminal'
      ? state.activeTabId
      : worktreeId
        ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
        : null
  const manager = tabId ? window.__paneManagers?.get(tabId) : null
  const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
  const buffer = pane?.terminal.buffer.active
  const line = buffer?.getLine(buffer.baseY + buffer.cursorY)
  const cursorColumn = buffer ? Math.min(buffer.cursorX, pane!.terminal.cols - 1) : 0
  const rowTailFromCursor = (line?.translateToString(true, cursorColumn) ?? '').trimEnd()

  if (!remainder) {
    return { ...empty, rowTailFromCursor, viewColor }
  }
  const inherited = getComputedStyle(remainder)
  const nodes: PreeditTailNode[] = Array.from(remainder.childNodes).map((node) => {
    const element = node instanceof HTMLElement ? node : null
    const style = element ? getComputedStyle(element) : inherited
    return {
      text: node.textContent ?? '',
      styled: element !== null,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle
    }
  })

  return {
    found: true,
    rowTailFromCursor,
    text: remainder.textContent ?? '',
    maskedVisibility: getComputedStyle(remainder).visibility,
    viewColor,
    nodes
  }
}

export async function samplePreeditTailPaint(page: Page): Promise<PreeditTailPaintSample> {
  return page.evaluate(readPreeditTailPaint)
}
