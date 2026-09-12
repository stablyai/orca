import type { FileDiffMetadata } from '@pierre/diffs'
import type { Editor } from '@pierre/diffs/edit'
import { getDiffContentSignature } from '../diff-content-signature'
import { setWithLRU } from '@/lib/scroll-cache'
import { getPierreSelectionRange, selectionSide } from './pierre-diff-selection'
import { getPierreSearchRanges, pierreSearchRevealLine } from './pierre-diff-search-view'
import type { PierreDiffInstance } from './PierreDiffSurface'
import type { DiffSearchMatch } from './pierre-diff-search'
import type { DiffSearchSide } from './PierreDiffSearchBar'

export type PierreNativeViewState = {
  scrollLeft: number
  selection?: {
    range: NonNullable<ReturnType<typeof getPierreSelectionRange>>
    side: DiffSearchSide
    signature: string
    backward: boolean
  }
}
const cache = new Map<string, PierreNativeViewState>()
export function rememberPierreNativeView(key: string, state: PierreNativeViewState) {
  setWithLRU(cache, key, state)
}
export function getPierreNativeView(key: string) {
  return cache.get(key)
}

function sourceSignature(diff: FileDiffMetadata, side: DiffSearchSide): string {
  return getDiffContentSignature(
    (side === 'deletions' ? diff.deletionLines : diff.additionLines).join('')
  )
}
export function readPierreNativeSelection(
  host: HTMLElement,
  diff: FileDiffMetadata,
  editable: boolean
): PierreNativeViewState['selection'] {
  const root = host.shadowRoot as ShadowRoot & { getSelection?: () => Selection | null }
  const selection = root?.getSelection?.()
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
): boolean {
  if (saved.signature !== sourceSignature(diff, saved.side)) {
    return true
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
  const selection = (
    host.shadowRoot as ShadowRoot & { getSelection?: () => Selection | null }
  )?.getSelection?.()
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
