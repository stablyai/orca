import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { scrollTopCache, setWithLRU } from '../model-lifetime/retention/editor-view-state-cache'

type SavedCodeMirrorSelection = {
  anchor: number
  head: number
}

const codemirrorSelectionCache = new Map<string, SavedCodeMirrorSelection>()

/** Listen to CodeMirror scroll changes with a 150ms trailing debounce to persist resting scrollTop. */
export function installCodeMirrorScrollTracking(
  view: EditorView,
  viewStateKey: string
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const scroller = view.scrollDOM

  const onScroll = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      setWithLRU(scrollTopCache, viewStateKey, scroller.scrollTop)
      timer = null
    }, 150)
  }

  scroller.addEventListener('scroll', onScroll, { passive: true })
  return () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    scroller.removeEventListener('scroll', onScroll)
  }
}

/** Save the current scroll position and primary selection when leaving or unmounting a file. */
export function snapshotCodeMirrorViewState(view: EditorView, viewStateKey: string): void {
  setWithLRU(scrollTopCache, viewStateKey, view.scrollDOM.scrollTop)
  const main = view.state.selection.main
  setWithLRU(codemirrorSelectionCache, viewStateKey, { anchor: main.anchor, head: main.head })
}

/** Restore persisted selection and scroll position (skipped for scroll when reveal/liveTail owns scroll). */
export function restoreCodeMirrorViewState(
  view: EditorView,
  viewStateKey: string,
  restoreScroll: boolean
): void {
  const savedSel = codemirrorSelectionCache.get(viewStateKey)
  if (savedSel) {
    const maxOffset = view.state.doc.length
    view.dispatch({
      selection: {
        anchor: Math.min(Math.max(0, savedSel.anchor), maxOffset),
        head: Math.min(Math.max(0, savedSel.head), maxOffset)
      }
    })
  }
  if (!restoreScroll) {
    return
  }
  const savedScrollTop = scrollTopCache.get(viewStateKey)
  if (savedScrollTop !== undefined) {
    requestAnimationFrame(() => {
      if (view.dom.isConnected) {
        view.scrollDOM.scrollTop = savedScrollTop
      }
    })
  }
}

/** Compute 0-based UTF-16 selection endpoints for a 1-based reveal line, column, and optional match length. */
export function computeRevealSelectionRange(
  doc: Text,
  line1Based: number,
  column1Based?: number,
  matchLength?: number
): { anchor: number; head: number } {
  const clampedLine = Math.min(Math.max(1, line1Based), doc.lines)
  const lineInfo = doc.line(clampedLine)
  const colOffset = Math.max(0, (column1Based ?? 1) - 1)
  const from = Math.min(lineInfo.from + colOffset, lineInfo.to)
  const head =
    matchLength != null && matchLength > 0 ? Math.min(from + matchLength, lineInfo.to) : from
  return { anchor: from, head }
}
