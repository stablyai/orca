import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  NATIVE_CHAT_UNKERNED_STYLE,
  isHighSurrogate,
  isLowSurrogate,
  nativeChatBreaksUnkernedRun,
  nativeChatUnkernedRuns
} from './native-chat-unkerned-runs'

type Range = [number, number]
type UnkernedState = { set: DecorationSet; pending: Range | null }

function addRunDecorations(decorations: Decoration[], text: string, textPos: number): void {
  for (const [start, end] of nativeChatUnkernedRuns(text)) {
    // Not inclusive: an inclusive edge can map across a joined block's boundary, where it can't be removed.
    decorations.push(
      Decoration.inline(textPos + start, textPos + end, { style: NATIVE_CHAT_UNKERNED_STYLE }, {})
    )
  }
}

function allDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.isText) {
      addRunDecorations(decorations, node.text ?? '', pos)
    }
    return !node.isInline
  })
  return DecorationSet.create(doc, decorations)
}

function union(a: Range | null, b: Range | null): Range | null {
  return a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : (a ?? b)
}

function changedHull(tr: Transaction): Range | null {
  let hull: Range | null = null
  tr.mapping.maps.forEach((map, index) => {
    const rest = tr.mapping.slice(index + 1)
    map.forEach((_oldFrom, _oldTo, from, to) => {
      hull = union(hull, [rest.map(from, -1), rest.map(to, 1)])
    })
  })
  return hull
}

/** Where the run through `pos` ends in direction `dir`; the text beyond `pos` is unchanged. */
function runEdge(doc: ProseMirrorNode, set: DecorationSet, pos: number, dir: -1 | 1): number {
  const $pos = doc.resolve(pos)
  const node = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter
  if (!node?.isText || !node.text) {
    return pos
  }
  // A decoration over the unchanged side already knows where that run ends.
  const covering = set
    .find(pos - 1, pos + 1)
    .find((d) => (dir < 0 ? d.from < pos && d.to >= pos : d.to > pos && d.from <= pos))
  if (covering) {
    return dir < 0 ? covering.from : covering.to
  }
  const { text } = node
  if (dir < 0) {
    for (let index = text.length - 1; index >= 0; index--) {
      const code = text.charCodeAt(index)
      // Ending on a supplementary ideograph's low surrogate, the run starts after the pair.
      const high = text.charCodeAt(index - 1)
      const pairEnd =
        isLowSurrogate(code) && isHighSurrogate(high) && nativeChatBreaksUnkernedRun(high)
      if (pairEnd || nativeChatBreaksUnkernedRun(code)) {
        return pos - (text.length - 1 - index)
      }
    }
    return pos - text.length
  }
  for (let index = 0; index < text.length; index++) {
    if (nativeChatBreaksUnkernedRun(text.charCodeAt(index))) {
      return pos + index
    }
  }
  return pos + text.length
}

// Why windowed: replacing every decoration in a block per keystroke is quadratic in its runs.
function rescan(doc: ProseMirrorNode, set: DecorationSet, [from, to]: Range): DecorationSet {
  const size = doc.content.size
  let left = runEdge(doc, set, Math.max(0, Math.min(from, size)), -1)
  const $left = doc.resolve(left)
  const before = $left.nodeBefore?.text ?? ''
  // An edit can complete a surrogate pair at the window's edge; classify the pair whole.
  if (
    isHighSurrogate(before.charCodeAt(before.length - 1)) &&
    isLowSurrogate(($left.nodeAfter?.text ?? '').charCodeAt(0))
  ) {
    left = runEdge(doc, set, left - 1, -1)
  }
  const right = runEdge(doc, set, Math.max(0, Math.min(to, size)), 1)
  const fresh: Decoration[] = []
  doc.nodesBetween(left, right, (node, pos) => {
    if (node.isText) {
      const start = Math.max(left, pos)
      const end = Math.min(right, pos + node.nodeSize)
      addRunDecorations(fresh, (node.text ?? '').slice(start - pos, end - pos), start)
    }
    return !node.isInline
  })
  const stale = set.find(left, right).filter((d) => d.from < right && d.to > left)
  const unchanged =
    stale.length === fresh.length &&
    stale.every((old, index) => old.from === fresh[index].from && old.to === fresh[index].to)
  return unchanged ? set : set.remove(stale).add(doc, fresh)
}

/** Turns kerning off only on runs long enough to stall layout; the text is untouched. */
export const NativeChatUnkernedRunDecorations = Extension.create({
  name: 'nativeChatUnkernedRunDecorations',
  addProseMirrorPlugins() {
    const key = new PluginKey<UnkernedState>('nativeChatUnkernedRunDecorations')
    return [
      new Plugin<UnkernedState>({
        key,
        state: {
          init: (_, state) => ({ set: allDecorations(state.doc), pending: null }),
          apply: (tr, previous) => {
            const rescanRequested = tr.getMeta(key) === true
            if (!tr.docChanged && !rescanRequested) {
              return previous
            }
            const set = previous.set.map(tr.mapping, tr.doc)
            const mappedPending: Range | null = previous.pending && [
              tr.mapping.map(previous.pending[0], -1),
              tr.mapping.map(previous.pending[1], 1)
            ]
            const pending = union(mappedPending, changedHull(tr))
            // Why: redecorating mid-composition re-renders the IME's text node; rescan once it ends.
            if (tr.getMeta('composition') !== undefined) {
              return { set, pending }
            }
            return { set: pending ? rescan(tr.doc, set, pending) : set, pending: null }
          }
        },
        props: {
          decorations: (state) => key.getState(state)?.set,
          handleDOMEvents: {
            // A composition can end with no further doc change, so ask for its rescan.
            compositionend: (view) => {
              setTimeout(() => {
                if (!view.isDestroyed && !view.composing && key.getState(view.state)?.pending) {
                  view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false))
                }
              })
              return false
            }
          }
        }
      })
    ]
  }
})
