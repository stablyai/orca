import type { OverlayRectSource } from '../../describe-page/browser-annotation-geometry'
import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { BrowserGrabLabelAvoidArea } from '../../../../../../shared/browser/element-grab/browser-grab-types'

// Until the page is registered with main (a fresh page), the area is refused; try again for a few seconds.
const RETRY_MS = 300
const MAX_RETRIES = 10

/** The palette and hint's footprint relative to the page frame, in this window's pixels; null if unmeasurable. */
export function measureGrabLabelAvoidArea(
  frame: OverlayRectSource,
  covers: readonly (HTMLElement | null)[]
): BrowserGrabLabelAvoidArea | null {
  const frameRect = frame.getBoundingClientRect()
  if (frameRect.width <= 0 || frameRect.height <= 0) {
    return null
  }
  const rects = covers
    .filter((cover): cover is HTMLElement => cover !== null)
    .map((cover) => cover.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
  if (rects.length === 0) {
    return null
  }
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.right))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return {
    x: Math.round(left - frameRect.left),
    y: Math.round(top - frameRect.top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
    frameWidth: Math.round(frameRect.width),
    frameHeight: Math.round(frameRect.height)
  }
}

function sameArea(
  a: BrowserGrabLabelAvoidArea | null,
  b: BrowserGrabLabelAvoidArea | null
): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.frameWidth === b.frameWidth &&
    a.frameHeight === b.frameHeight
  )
}

type Producer = {
  owner: object | null
  active: boolean
  dirty: boolean
  pending: { owner: object | null; area: BrowserGrabLabelAvoidArea | null } | null
  accepted: BrowserGrabLabelAvoidArea | null
  notify: ((accepted: boolean) => void) | null
}
const producers = new Map<string, Producer>()

function drain(pageId: string, producer: Producer): void {
  if (producer.active) {
    return
  }
  producer.active = true
  void (async () => {
    while (producer.pending) {
      const update = producer.pending
      producer.pending = null
      if (update.area) {
        producer.dirty = true
      }
      let accepted = false
      try {
        accepted = await window.api.browser.setGrabLabelAvoidArea({
          browserPageId: pageId,
          area: update.area
        })
      } catch {}
      if (accepted && update.area === null) {
        producer.dirty = false
      }
      if (producer.owner === update.owner && !producer.pending) {
        producer.accepted = accepted ? update.area : null
        producer.notify?.(accepted)
      }
    }
    producer.active = false
    if (!producer.owner && producers.get(pageId) === producer) {
      producers.delete(pageId)
    }
  })()
}

/** One in-flight delivery and one latest footprint per page, shared across palette mounts. */
export function useGrabLabelAvoidArea({
  pageId,
  frameRef,
  paletteRef,
  hintRef,
  enabled,
  layoutKey
}: {
  pageId: string
  frameRef: RefObject<OverlayRectSource | null> | undefined
  paletteRef: RefObject<HTMLElement | null>
  hintRef: RefObject<HTMLElement | null>
  enabled: boolean
  layoutKey: string
}): void {
  const leaseRef = useRef<{ producer: Producer; owner: object } | null>(null)
  useLayoutEffect(() => {
    let producer = producers.get(pageId)
    if (!producer) {
      producer = {
        owner: null,
        active: false,
        dirty: false,
        pending: null,
        accepted: null,
        notify: null
      }
      producers.set(pageId, producer)
    }
    const owner = {}
    producer.owner = owner
    producer.accepted = null
    producer.notify = null
    // A newer mount supersedes an older cleanup that has not yet been delivered.
    producer.pending = null
    leaseRef.current = { producer, owner }
    return () => {
      if (producer.owner !== owner) {
        return
      }
      producer.owner = null
      producer.notify = null
      if (producer.dirty || producer.active || producer.pending) {
        producer.pending = { owner: null, area: null }
        drain(pageId, producer)
      } else if (producers.get(pageId) === producer) {
        producers.delete(pageId)
      }
    }
  }, [pageId])

  useLayoutEffect(() => {
    const frame = frameRef?.current
    const palette = paletteRef.current
    const lease = leaseRef.current
    if (!enabled || !frame || !palette || !lease) {
      return
    }
    const { producer, owner } = lease
    let disposed = false
    let retryTimer: number | undefined
    let retries = 0
    const report = (): void => {
      window.clearTimeout(retryTimer)
      if (disposed || producer.owner !== owner) {
        return
      }
      const area = measureGrabLabelAvoidArea(frame, [palette, hintRef.current])
      if (
        !area ||
        (!producer.active && sameArea(area, producer.accepted)) ||
        (producer.pending?.owner === owner && sameArea(area, producer.pending.area))
      ) {
        return
      }
      producer.pending = { owner, area }
      drain(pageId, producer)
    }
    producer.notify = (accepted) => {
      if (disposed) {
        return
      }
      if (accepted) {
        retries = 0
        return
      }
      if (retries < MAX_RETRIES) {
        retries += 1
        retryTimer = window.setTimeout(report, RETRY_MS)
      }
    }
    report()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    if (frame instanceof Element) {
      observer?.observe(frame)
    }
    observer?.observe(palette)
    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      observer?.disconnect()
      if (producer.owner === owner) {
        producer.notify = null
      }
    }
  }, [enabled, frameRef, hintRef, layoutKey, pageId, paletteRef])
}
