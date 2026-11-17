import { getShadowRootSelection } from '@/lib/shadow-root-selection'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { Editor, EditorViewState } from '@pierre/diffs/edit'
import { getDiffContentSignature } from '@/components/editor/diff/sections/diff-content-signature'
import { setWithLRU } from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import { getPierreSelectionRange, selectionSide } from './pierre-diff-selection'
import { getPierreSearchRanges, pierreSearchRevealLine } from './pierre-diff-search-view'
import type { PierreDiffInstance } from './PierreDiffSurface'
import type { DiffSearchMatch } from './pierre-diff-search'
import type { DiffSearchSide } from './PierreDiffSearchBar'

export type PierreNativeViewState = {
  scrollLeft: number
  editor?: EditorViewState
  selection?: {
    range: NonNullable<ReturnType<typeof getPierreSelectionRange>>
    side: DiffSearchSide
    signature: string
    backward: boolean
  }
}
const cache = new Map<string, PierreNativeViewState>()
const signatures = new WeakMap<string[], string>()
export function rememberPierreNativeView(key: string, state: PierreNativeViewState) {
  setWithLRU(cache, key, state)
}
export function getPierreNativeView(key: string) {
  return cache.get(key)
}

function sourceSignature(diff: FileDiffMetadata, side: DiffSearchSide): string {
  // Parsed snapshots are immutable; Pierre edits separate session-owned line arrays.
  const lines = side === 'deletions' ? diff.deletionLines : diff.additionLines
  let signature = signatures.get(lines)
  if (signature === undefined) {
    signature = getDiffContentSignature(lines.join(''))
    signatures.set(lines, signature)
  }
  return signature
}
export function readPierreNativeSelection(
  host: HTMLElement,
  diff: FileDiffMetadata,
  editable: boolean
): PierreNativeViewState['selection'] {
  const root = host.shadowRoot
  const selection = getShadowRootSelection(root)
  if (
    !root?.contains(selection?.anchorNode ?? null) ||
    !root.contains(selection?.focusNode ?? null)
  ) {
    return
  }
  const range = getPierreSelectionRange(selection ?? null)
  if (!range || !selection) {
    return
  }
  const nativeRange = selection.getRangeAt(0)
  const side = selectionSide(nativeRange.startContainer) ?? 'additions'
  if (editable && side === 'additions') {
    return
  }
  return {
    range,
    side,
    signature: sourceSignature(diff, side),
    backward:
      selection.anchorNode === nativeRange.endContainer &&
      selection.anchorOffset === nativeRange.endOffset
  }
}

export function restorePierreNativeSelection(
  host: HTMLElement,
  diff: FileDiffMetadata,
  saved: NonNullable<PierreNativeViewState['selection']>,
  instance: PierreDiffInstance,
  editor?: Pick<Editor, 'setDeletedTextSelectionActive'> | null
): boolean | 'stale' {
  if (saved.signature !== sourceSignature(diff, saved.side)) {
    return 'stale'
  }
  const { range, side } = saved
  if (
    instance.revealLine(pierreSearchRevealLine(diff, range.startLineNumber, side)) ||
    instance.revealLine(pierreSearchRevealLine(diff, range.endLineNumber, side))
  ) {
    return false
  }
  const match: DiffSearchMatch = {
    start: 0,
    end: 0,
    replacement: '',
    range: {
      start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
      end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
    }
  }
  const { activeStart: first, activeEnd: last } = getPierreSearchRanges(
    host,
    diff,
    side,
    [match],
    match
  )
  if (!first || !last) {
    return false
  }
  const selection = getShadowRootSelection(host.shadowRoot)
  if (!selection) {
    return false
  }
  const start = { node: first.startContainer, offset: first.startOffset }
  const end = { node: last.endContainer, offset: last.endOffset }
  editor?.setDeletedTextSelectionActive(side === 'deletions')
  selection.setBaseAndExtent(
    saved.backward ? end.node : start.node,
    saved.backward ? end.offset : start.offset,
    saved.backward ? start.node : end.node,
    saved.backward ? start.offset : end.offset
  )
  return true
}
