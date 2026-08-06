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
  // Why: true while a restore has written toward the anchor but the anchored
  // row's position is not yet confirmed; the caller re-runs the restore across
  // measurement ticks until it converges or the user scrolls.
  pendingRestoreRef: MutableRefObject<boolean>
  programmaticScrollMarks?: ProgrammaticScrollMarks
  recordScrollAnchor: (scrollTop: number) => void
  // Why: old key -> new key for rows that were re-keyed without moving. Lets an
  // anchor follow its own row instead of resolving a fallback row below it.
  rekeyedRowKeys?: ReadonlyMap<string, string>
  rowIndexByKey: ReadonlyMap<string, number>
  scrollOffsetRef: MutableRefObject<number>
  virtualizer: Virtualizer<TScrollElement, TItemElement>
}

/**
 * One restore attempt: pin the anchored row back to its recorded viewport
 * offset. Prefers the row's live DOM position, then its measured virtual slot,
 * then scrollToIndex to bring it into the window. Every scroll write is
 * registered with the marks so scroll listeners attribute it to this code,
 * not the user. Returns a cleanup for the scrollToIndex follow-up frame.
 */
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
    // Why: an unresolvable anchor has nothing to converge; rows that make it
    // resolvable again always arrive via a signal change, so leaving the arm
    // set would re-run restore on every measurement tick.
    pendingRestoreRef.current = false
    return
  }
  const index = rowIndexByKey.get(resolvedKey)
  if (index === undefined) {
    pendingRestoreRef.current = false
    return
  }
  // Why: a fallback key means the anchored row was REMOVED and the row below
  // slid up — a different row, so the within-row offset does not transfer. A
  // followed key is the SAME row under a new key, so it does.
  const followedRow = resolvedKey === followedKey
  const offset = hasExactKey || followedRow ? anchor.offset : 0
  // Why: the followed row can be a different height than the one the offset was
  // recorded against (a lineage group dissolving back to a single card), so
  // clamp it the same way recording does.
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
      // Why: this scroll write is still part of restore; keep the target
      // anchor until a later layout confirms the intended row is in place.
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
    // Why: measured fallback can run while TanStack's virtual window is
    // transitional, so recording here can replace the target with a wrong row.
    scrollOffsetRef.current = el.scrollTop
    anchor.scrollTop = el.scrollTop
    // Why: without a DOM selector there is no later confirmation step; the
    // measured landing is final, so don't re-arm restore ticks forever.
    pendingRestoreRef.current = canConfirmFromDom
    return true
  }

  if (restoreFromDomElement()) {
    return
  }

  // Why: right after a delete the virtualizer can briefly render the wrong
  // window, so the anchor row's DOM node isn't mounted yet even though the
  // virtualizer still has its measured slot. Pin from that measured start
  // (preserving the within-row offset) before falling back to scrollToIndex,
  // whose align:'start' snaps the row to the viewport top and visibly jumps.
  if (restoreFromMeasuredItem()) {
    return
  }

  // Why: the anchored row is outside the virtualizer's current window — no
  // DOM node and no measured slot. Bring it in, then apply the within-row
  // offset once TanStack Virtual has mounted and measured that row.
  // scrollToIndex marks its write via the caller-supplied scrollToFn.
  pendingRestoreRef.current = true
  virtualizer.scrollToIndex(index, { align: 'start' })
  anchor.scrollTop = el.scrollTop
  const frameId = window.requestAnimationFrame(() => {
    if (!pendingRestoreRef.current) {
      // Why: an unmarked (user) scroll disarmed the restore between the
      // effect and this frame; writing now would fight their input.
      return
    }
    if (!restoreFromDomElement()) {
      restoreFromMeasuredItem()
    }
  })
  return () => window.cancelAnimationFrame(frameId)
}
