import type { NativeChatRowTypography } from './native-chat-row-height-estimate'
import { nativeChatPinnedRowIndexes } from './native-chat-pinned-rows'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { NativeChatSubagentSections } from './native-chat-subagent-sections'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import { useNativeChatReadingPosition } from './native-chat-reading-position'
export type NativeChatTranscriptWindowOptions = {
  scrollRef: React.RefObject<HTMLDivElement | null>
  slots: readonly NativeChatTranscriptSlot[]
  journalEpoch?: string | null
  readCurrent?: boolean
  subagentSections?: NativeChatSubagentSections
  revealIndex: number
  newRowsMarkerIndex?: number
  typography?: NativeChatRowTypography
  isVisible: boolean
}
type ReadingScroll = Pick<Virtualizer<HTMLDivElement, Element>, 'scrollToIndex' | 'scrollToOffset'>
export function useNativeChatTranscriptReading({
  scrollRef,
  slots,
  journalEpoch,
  readCurrent,
  subagentSections,
  isVisible,
  revealIndex,
  newRowsMarkerIndex
}: NativeChatTranscriptWindowOptions) {
  const reading = useNativeChatReadingPosition()
  const restore = useRef(
    reading.current.anchor && !reading.current.followingEnd ? reading.current.anchor : null
  )
  const frame = useRef(0)
  const [restoring, setRestoring] = useState(restore.current !== null)
  const rowIndexes = useMemo(
    () => new Map(slots.map((slot, index) => [nativeChatSlotKey(slot), index])),
    [slots]
  )
  const restoreIndex = restore.current ? (rowIndexes.get(restore.current.rowKey) ?? -1) : -1
  useLayoutEffect(() => {
    const changedEpoch =
      journalEpoch && reading.current.anchor?.epoch && reading.current.anchor.epoch !== journalEpoch
    if (changedEpoch || (restore.current && readCurrent && restoreIndex < 0)) {
      restore.current = null
      reading.current = { followingEnd: true, anchor: changedEpoch ? null : reading.current.anchor }
      setRestoring(false)
    }
  }, [journalEpoch, reading, readCurrent, restoreIndex])
  const pinned = useMemo(() => {
    const indexes = new Set(
      nativeChatPinnedRowIndexes({ count: slots.length, revealIndex, newRowsMarkerIndex })
    )
    if (restoring && restoreIndex >= 0) {
      indexes.add(restoreIndex)
    }
    return indexes
  }, [slots.length, revealIndex, newRowsMarkerIndex, restoring, restoreIndex])
  const cancelRestore = useCallback(() => {
    cancelAnimationFrame(frame.current)
    restore.current = null
    setRestoring(false)
  }, [])
  const reconcile = useCallback(
    (virtualizer: ReadingScroll) => {
      const saved = restore.current
      const container = scrollRef.current
      if (!isVisible || !saved || restoreIndex < 0 || !container) {
        return
      }
      let stable = 0
      const deadline = performance.now() + 1000
      virtualizer.scrollToIndex(restoreIndex, { align: 'start', behavior: 'auto' })
      const reconcile = () => {
        if (restore.current !== saved) {
          return
        }
        const row = Array.from(
          container.querySelectorAll<HTMLElement>('[data-native-chat-row-key]')
        ).find((element) => element.dataset.nativeChatRowKey === saved.rowKey)
        if (row) {
          const within = Math.min(
            saved.offsetWithinRow,
            Math.max(0, row.getBoundingClientRect().height - 1)
          )
          const delta =
            row.getBoundingClientRect().top - container.getBoundingClientRect().top + within
          if (Math.abs(delta) <= 1) {
            stable += 1
          } else {
            stable = 0
            virtualizer.scrollToOffset(container.scrollTop + delta, { behavior: 'auto' })
          }
          if (stable >= 2) {
            restore.current = null
            setRestoring(false)
            return
          }
        }
        if (performance.now() < deadline) {
          frame.current = requestAnimationFrame(reconcile)
        }
        // A missed layout deadline keeps the compact anchor for a later authoritative reveal.
      }
      frame.current = requestAnimationFrame(reconcile)
      return () => cancelAnimationFrame(frame.current)
    },
    [isVisible, restoreIndex, scrollRef]
  )
  const captureReadingPosition = useCallback(
    (followingEnd: boolean) => {
      const container = scrollRef.current
      if (!isVisible || !container || container.clientHeight <= 0 || restore.current) {
        return
      }
      if (followingEnd) {
        reading.current = { followingEnd, anchor: null }
        return
      }
      const { top, bottom } = container.getBoundingClientRect()
      const row = Array.from(
        container.querySelectorAll<HTMLElement>('[data-native-chat-row-key]')
      ).find((element) => {
        const rect = element.getBoundingClientRect()
        return rect.bottom > top && rect.top < bottom
      })
      if (row?.dataset.nativeChatRowKey) {
        const slot = slots[Number(row.dataset.index)]
        const roster =
          slot?.kind === 'subagent-entries'
            ? slots[rowIndexes.get(slot.rosterRowId) ?? -1]
            : undefined
        const position =
          slot?.kind === 'message'
            ? slot.message.journalPosition
            : slot?.kind === 'subagent'
              ? (subagentSections?.rosters.get(slot.agentId)?.position ??
                subagentSections?.rows.get(slot.agentId)?.[0]?.message.journalPosition)
              : slot?.kind === 'subagent-entries'
                ? roster?.kind === 'message'
                  ? roster.message.journalPosition
                  : undefined
                : undefined
        reading.current = {
          followingEnd,
          anchor: {
            rowKey: row.dataset.nativeChatRowKey,
            ...(journalEpoch ? { epoch: journalEpoch } : {}),
            ...(position ? { sequence: position.sequence } : {}),
            offsetWithinRow: Math.max(0, top - row.getBoundingClientRect().top)
          }
        }
      } else {
        reading.current = { ...reading.current, followingEnd }
      }
    },
    [isVisible, journalEpoch, reading, rowIndexes, scrollRef, slots, subagentSections]
  )
  return { pinned, reading, restore, cancelRestore, reconcile, captureReadingPosition }
}
