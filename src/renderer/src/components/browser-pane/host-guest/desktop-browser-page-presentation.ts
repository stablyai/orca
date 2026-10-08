import {
  getNativeViewOcclusionSnapshot,
  isNativeViewOccluded,
  subscribeNativeViewOcclusion
} from '@/lib/native-view-occlusion'
import type { DesktopBrowserViewLayout } from '../../../../../shared/desktop-browser-view-protocol'
import { claimDesktopBrowserPage, type DesktopBrowserPage } from './desktop-browser-page-registry'

export type DesktopBrowserPagePresentation = {
  active: boolean
  inputLocked: boolean
  hidden: boolean
}

export function presentDesktopBrowserPage({
  page,
  content,
  scroller,
  state,
  onFrame,
  onMode,
  onError
}: {
  page: DesktopBrowserPage
  content: HTMLElement
  scroller: HTMLElement
  state: () => DesktopBrowserPagePresentation
  onFrame: (dataUrl: string) => void
  onMode: (forwarded: boolean) => void
  onError: (error: unknown) => void
}): { refresh: () => void; isCurrent: () => boolean; dispose: () => void } {
  const claim = claimDesktopBrowserPage(page)
  let disposed = false
  let animation: number | undefined
  let captureTimer: ReturnType<typeof setTimeout> | undefined
  let capturePending = false
  let forwarded = false
  let pending: DesktopBrowserViewLayout | null = null
  let writing: Promise<void> | null = null
  let lastWritten = ''
  page.getBounds = () => (content.isConnected ? content.getBoundingClientRect() : null)

  const write = (): Promise<void> => {
    if (writing) {
      return writing
    }
    writing = (async () => {
      try {
        while (pending && claim.isCurrent() && !disposed) {
          const layout = pending
          pending = null
          if (JSON.stringify(layout) === lastWritten) {
            continue
          }
          await page.api.updateLayout(layout)
          lastWritten = JSON.stringify(layout)
        }
      } catch (error) {
        if (!disposed) {
          onError(error)
        }
      }
    })().finally(() => {
      writing = null
    })
    return writing
  }
  const capture = async (): Promise<void> => {
    if (capturePending || disposed || !forwarded || !claim.isCurrent()) {
      return
    }
    capturePending = true
    try {
      await write()
      if (
        disposed ||
        !forwarded ||
        !claim.isCurrent() ||
        lastWritten !== JSON.stringify(page.layout)
      ) {
        return
      }
      const result = await page.surface.captureViewport()
      if (result && !disposed && forwarded && claim.isCurrent()) {
        onFrame(result.dataUrl)
      }
    } catch (error) {
      if (!disposed) {
        onError(error)
      }
    } finally {
      capturePending = false
      if (!disposed && forwarded && claim.isCurrent()) {
        captureTimer = setTimeout(() => {
          void capture()
        }, 100)
      }
    }
  }
  const refresh = (): void => {
    if (disposed || !claim.isCurrent()) {
      return
    }
    const current = state()
    const rect = content.getBoundingClientRect()
    const clip = scroller.getBoundingClientRect()
    const connected =
      content.isConnected &&
      scroller.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      clip.width > 0 &&
      clip.height > 0
    const occlusion = getNativeViewOcclusionSnapshot()
    const occluded = connected && isNativeViewOccluded(clip, occlusion)
    const nextForwarded =
      connected &&
      current.active &&
      !current.hidden &&
      !current.inputLocked &&
      occluded &&
      !occlusion.windowBlocked
    // Modal surfaces still need a current background, but cannot forward input.
    const needFrame =
      connected && current.active && !current.hidden && (occluded || current.inputLocked)
    const startCapture = !forwarded && needFrame
    if (forwarded !== needFrame) {
      forwarded = needFrame
      clearTimeout(captureTimer)
    }
    onMode(nextForwarded)
    const layout: DesktopBrowserViewLayout = {
      browserPageId: page.state.browserPageId,
      generation: page.state.generation,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height))
      },
      clipBounds: {
        x: Math.round(clip.x),
        y: Math.round(clip.y),
        width: Math.max(1, Math.round(clip.width)),
        height: Math.max(1, Math.round(clip.height))
      },
      visible: connected && current.active && !current.hidden && !occluded,
      inputLocked: current.inputLocked,
      forwardInput: nextForwarded
    }
    if (!connected && page.layout) {
      layout.bounds = page.layout.bounds
      layout.clipBounds = page.layout.clipBounds
    }
    if (
      (writing || JSON.stringify(layout) !== lastWritten) &&
      JSON.stringify(layout) !== JSON.stringify(pending)
    ) {
      page.layout = layout
      pending = layout
      void write()
    }
    if (startCapture) {
      void capture()
    }
    if (current.active && animation === undefined) {
      animation = requestAnimationFrame(tick)
    } else if (!current.active && animation !== undefined) {
      cancelAnimationFrame(animation)
      animation = undefined
    }
  }
  const tick = (): void => {
    animation = undefined
    refresh()
  }
  const observer = new ResizeObserver(refresh)
  observer.observe(content)
  observer.observe(scroller)
  const unsubscribe = subscribeNativeViewOcclusion(refresh)
  scroller.addEventListener('scroll', refresh, { passive: true })
  window.addEventListener('resize', refresh)
  refresh()
  return {
    refresh,
    isCurrent: () => !disposed && claim.isCurrent(),
    dispose: () => {
      disposed = true
      pending = null
      if (animation !== undefined) {
        cancelAnimationFrame(animation)
      }
      clearTimeout(captureTimer)
      observer.disconnect()
      unsubscribe()
      scroller.removeEventListener('scroll', refresh)
      window.removeEventListener('resize', refresh)
      void claim.release().catch(onError)
    }
  }
}
