import { useEffect, useRef, useState } from 'react'
import type { PaneSize } from './emulator-device-frame-layout'

export function useEmulatorPaneSize() {
  const paneRef = useRef<HTMLDivElement | null>(null)
  const [paneSize, setPaneSize] = useState<PaneSize | null>(null)

  useEffect(() => {
    const node = paneRef.current
    if (!node) {
      return
    }
    let frameId: number | null = null
    const updateSize = (): void => {
      const rect = node.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.floor(rect.height)
      setPaneSize((current) =>
        current?.width === width && current.height === height ? current : { width, height }
      )
    }
    const scheduleUpdate = (): void => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
      frameId = requestAnimationFrame(() => {
        frameId = null
        updateSize()
      })
    }

    updateSize()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', scheduleUpdate)
      return () => {
        if (frameId !== null) {
          cancelAnimationFrame(frameId)
        }
        window.removeEventListener('resize', scheduleUpdate)
      }
    }

    const observer = new ResizeObserver(scheduleUpdate)
    observer.observe(node)
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
      observer.disconnect()
    }
  }, [])

  return { paneRef, paneSize }
}
