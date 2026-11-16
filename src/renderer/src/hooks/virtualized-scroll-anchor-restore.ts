import type { MutableRefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ProgrammaticScrollMarks } from './programmatic-scroll-marks'
import type { VirtualizedScrollAnchor } from './useVirtualizedScrollAnchor'

type RunVirtualizedScrollAnchorRestoreArgs<
  TScrollElement extends Element,
  TItemElement extends Element
> = {
  anchor: NonNullable<VirtualizedScrollAnchor>
  el: TScrollElement
  getItemElementKey?: (element: TItemElement) => string | null
  itemElementSelector?: string
  // Retry across measurement ticks until row geometry confirms the landing or the user takes over.
  pendingRestoreRef: MutableRefObject<boolean>
  programmaticScrollMarks?: ProgrammaticScrollMarks
  recordScrollAnchor: (scrollTop: number) => void
  // Follow the same row under a new key instead of falling back to a neighbor.
  rekeyedRowKeys?: ReadonlyMap<string, string>
  rowIndexByKey: ReadonlyMap<string, number>
  scrollOffsetRef: MutableRefObject<number>
  virtualizer: Virtualizer<TScrollElement, TItemElement>
}

/** Restore the row’s viewport offset using DOM geometry, then a measured slot, then scrollToIndex; mark every write as programmatic. Returns cleanup for the follow-up frame. */
export function runVirtualizedScrollAnchorRestore<
  TScrollElement extends Element,
  TItemElement extends Element
>({
  anchor,
  el,
  getItemElementKey,
  itemElementSelector,
  pendingRestoreRef,
  programmaticScrollMarks,
  recordScrollAnchor,
  rekeyedRowKeys,
  rowIndexByKey,
  scrollOffsetRef,
  virtualizer
}: RunVirtualizedScrollAnchorRestoreArgs<TScrollElement, TItemElement>): (() => void) | undefined {
  const hasExactKey = rowIndexByKey.has(anchor.key)
  const rekeyed = hasExactKey ? undefined : rekeyedRowKeys?.get(anchor.key)
  // Why: only follow a rekey that names a row present in this render.
  const followedKey = rekeyed !== undefined && rowIndexByKey.has(rekeyed) ? rekeyed : undefined
  const resolvedKey = hasExactKey
    ? anchor.key
    : (followedKey ?? anchor.fallbackKeys?.find((key) => rowIndexByKey.has(key)))
  if (!resolvedKey) {
    // Disarm unresolvable anchors; a new structural signal must accompany later resolvability.
    pendingRestoreRef.current = false
    return
  }
  const index = rowIndexByKey.get(resolvedKey)
  if (index === undefined) {
    pendingRestoreRef.current = false
    return
  }
  // Preserve within-row offset only for the same/rekeyed row; a fallback names a different row.
  const followedRow = resolvedKey === followedKey
  const offset = hasExactKey || followedRow ? anchor.offset : 0
  // A rekey can shrink the row, such as a dissolved lineage group; clamp its preserved offset.
  const offsetWithinRow = (rowHeight: number): number =>
    followedRow ? Math.min(rowHeight, offset) : offset
  const canConfirmFromDom = Boolean(itemElementSelector && getItemElementKey)

  const restoreFromDomElement = (): boolean => {
    if (!itemElementSelector || !getItemElementKey) {
      return false
    }
    const element =
      Array.from(el.querySelectorAll<TItemElement>(itemElementSelector)).find(
        (candidate) => getItemElementKey(candidate) === resolvedKey && candidate.isConnected
      ) ?? null
    if (!element) {
      return false
    }
    const scrollRect = el.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    const desiredTop = scrollRect.top - offsetWithinRow(rect.height)
    const delta = rect.top - desiredTop
    if (Math.abs(delta) > 1) {
      // Keep the target anchor until later layout confirms the landing.
      programmaticScrollMarks?.mark(el.scrollTop + delta)
      el.scrollTop += delta
      scrollOffsetRef.current = el.scrollTop
      anchor.scrollTop = el.scrollTop
      pendingRestoreRef.current = true
      return true
    }
    scrollOffsetRef.current = el.scrollTop
    pendingRestoreRef.current = false
    recordScrollAnchor(el.scrollTop)
    return true
  }

  const restoreFromMeasuredItem = (): boolean => {
    const item = virtualizer.getVirtualItems().find((candidate) => candidate.index === index)
    if (!item) {
      return false
    }
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
    const nextScrollTop = Math.min(
      maxScrollTop,
      Math.max(0, item.start + offsetWithinRow(item.size))
    )
    if (Math.abs(el.scrollTop - nextScrollTop) > 1) {
      programmaticScrollMarks?.mark(nextScrollTop)
      el.scrollTop = nextScrollTop
    }
    // A transitional virtual window can report the wrong row; do not replace the target anchor here.
    scrollOffsetRef.current = el.scrollTop
    anchor.scrollTop = el.scrollTop
    // Without DOM confirmation, this measured landing is final; do not keep restore armed.
    pendingRestoreRef.current = canConfirmFromDom
    return true
  }

  if (restoreFromDomElement()) {
    return
  }

  // Use the measured slot while DOM mounting catches up; scrollToIndex would discard the within-row offset and jump.
  if (restoreFromMeasuredItem()) {
    return
  }

  // Bring an unmounted/unmeasured row into view, then apply its offset; the caller’s scrollToFn marks the write.
  pendingRestoreRef.current = true
  virtualizer.scrollToIndex(index, { align: 'start' })
  anchor.scrollTop = el.scrollTop
  const frameId = window.requestAnimationFrame(() => {
    if (!pendingRestoreRef.current) {
      // A user scroll disarmed restore before this frame; writing now would fight their input.
      return
    }
    if (!restoreFromDomElement()) {
      restoreFromMeasuredItem()
    }
  })
  return () => window.cancelAnimationFrame(frameId)
}
