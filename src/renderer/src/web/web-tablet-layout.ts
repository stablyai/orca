import { isIosWebPlatform } from '../app-shell/platform/ios-web-platform'
import { useEffect, useState } from 'react'

export const WEB_TABLET_MIN_WIDTH = 600

// Tablet means touch-first canvas: coarse pointer at pad width, or iPadOS at any width.
export function isTabletViewport(options: {
  width: number
  coarsePointer: boolean
  ipad: boolean
}): boolean {
  if (options.ipad) {
    return true
  }
  return options.coarsePointer && options.width >= WEB_TABLET_MIN_WIDTH
}

function readTabletState(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false
  }
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const ipad = isIosWebPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  return isTabletViewport({ width: window.innerWidth, coarsePointer: coarse, ipad })
}

export function useWebTabletLayout(): boolean {
  const [isTablet, setIsTablet] = useState(readTabletState)
  useEffect(() => {
    const update = (): void => setIsTablet(readTabletState())
    update()
    const media = window.matchMedia?.('(pointer: coarse)')
    media?.addEventListener('change', update)
    window.addEventListener('resize', update)
    return () => {
      media?.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return isTablet
}
