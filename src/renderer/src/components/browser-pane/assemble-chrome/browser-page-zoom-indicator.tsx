import { cn } from '@/lib/utils'
import { useNativeViewOcclusionRef } from '@/hooks/useNativeViewOcclusion'

export function BrowserPageZoomIndicator({
  state,
  percent
}: {
  state: { ariaHidden: boolean; opacityClassName: string }
  percent: number
}): React.JSX.Element {
  const occlusionRef = useNativeViewOcclusionRef<HTMLDivElement>()
  return (
    <div
      ref={state.ariaHidden ? undefined : occlusionRef}
      role="status"
      aria-live="polite"
      aria-hidden={state.ariaHidden}
      className={cn(
        'pointer-events-none absolute top-3 right-3 z-30 rounded-md border border-border bg-popover/95 px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-xs transition-opacity duration-300 ease-out',
        state.opacityClassName
      )}
    >
      {percent}%
    </div>
  )
}
