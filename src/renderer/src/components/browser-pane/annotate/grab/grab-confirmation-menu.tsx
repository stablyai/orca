import { useLayoutEffect, useState, type MutableRefObject, type RefObject } from 'react'
import { Copy, Image } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import {
  mapGuestRectToContainer,
  type OverlayRectSource
} from '../../describe-page/browser-annotation-geometry'
import type { GrabModeHook } from './useGrabMode'

export function GrabConfirmationMenu({
  grab,
  payload,
  menuActionTakenRef,
  containerRef,
  guestSurfaceRef,
  onCopy,
  onScreenshot
}: {
  grab: GrabModeHook
  payload: BrowserGrabPayload | null
  menuActionTakenRef: MutableRefObject<boolean>
  containerRef: RefObject<HTMLDivElement | null>
  guestSurfaceRef: RefObject<OverlayRectSource | null>
  onCopy: () => void
  onScreenshot: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [position, setPosition] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    if (!payload) {
      return
    }
    const rect = payload.target.rectViewport
    const webviewRect = guestSurfaceRef.current?.getBoundingClientRect()
    const containerRect = containerRef.current?.getBoundingClientRect()
    const mapped = mapGuestRectToContainer(
      rect,
      containerRect,
      webviewRect,
      payload.page.viewportWidth
    )
    setPosition({
      left: mapped.x + mapped.width / 2,
      top: mapped.y + mapped.height / 2
    })
  }, [payload, guestSurfaceRef, containerRef])
  return (
    <DropdownMenu
      open={grab.state === 'confirming' && grab.contextMenu && payload !== null}
      onOpenChange={(open) => {
        if (!open && grab.state === 'confirming') {
          // Why: skip rearm if a menu action already handled it — see menuActionTakenRef.
          if (menuActionTakenRef.current) {
            menuActionTakenRef.current = false
            return
          }
          grab.rearm()
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none absolute size-px opacity-0"
          style={position}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            if (payload) {
              onCopy()
            }
          }}
        >
          <Copy className="size-3.5" />
          {t('auto.components.browser.pane.BrowserPane.c2ef0359b9', 'Copy Contents')}
          <DropdownMenuShortcut>C</DropdownMenuShortcut>
        </DropdownMenuItem>
        {payload?.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              if (payload) {
                onScreenshot()
              }
            }}
          >
            <Image className="size-3.5" />
            {t('auto.components.browser.pane.BrowserPane.1ded0d3168', 'Copy Screenshot')}
            <DropdownMenuShortcut>S</DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            menuActionTakenRef.current = true
            grab.cancel()
          }}
        >
          {t('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
