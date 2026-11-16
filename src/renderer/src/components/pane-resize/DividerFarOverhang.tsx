import { useEffect } from 'react'
import { getDividerFarOverhangPx, installDividerNativeDragGuard } from '@/lib/divider-hit-area'

/**
 * Widens a resize strip to the right (the side without scrollbars) up to the shared grab size.
 * Render inside the strip: hover/active and mousedown reach the strip, so its look and handlers stay unchanged.
 */
export function DividerFarOverhang({ extentPx }: { extentPx: number }): React.JSX.Element {
  useEffect(() => {
    installDividerNativeDragGuard()
  }, [])
  return (
    <span
      aria-hidden
      data-divider-overhang=""
      className="absolute inset-y-0 left-full"
      style={{ width: getDividerFarOverhangPx(extentPx) }}
    />
  )
}
