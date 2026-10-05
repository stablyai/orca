import * as React from 'react'
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon
} from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

import { useSonnerNativeViewOcclusion } from '@/lib/sonner-native-view-occlusion'
import { useAppStore } from '@/store'

const Toaster = React.forwardRef<HTMLElement, ToasterProps>(({ ...props }, forwardedRef) => {
  const theme = useAppStore((s) => s.settings?.theme) || 'system'
  const [section, setSection] = React.useState<HTMLElement | null>(null)
  useSonnerNativeViewOcclusion(section)
  const setRef = React.useCallback(
    (node: HTMLElement | null) => {
      setSection(node)
      if (typeof forwardedRef === 'function') {
        forwardedRef(node)
      } else if (forwardedRef) {
        forwardedRef.current = node
      }
    },
    [forwardedRef]
  )

  return (
    <Sonner
      ref={setRef}
      theme={theme as ToasterProps['theme']}
      position="bottom-right"
      offset={{ bottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))' }}
      mobileOffset={{ bottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))' }}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          '--width': 'min(26rem, calc(100vw - 2rem))'
        } as React.CSSProperties
      }
      {...props}
    />
  )
})
Toaster.displayName = 'Toaster'

export { Toaster }
