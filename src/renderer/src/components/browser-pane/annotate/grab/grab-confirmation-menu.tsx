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
import type { GrabModeHook } from './useGrabMode'

export function GrabConfirmationMenu({
  grab,
  payload,
  menuActionTakenRef,
  containerRef,
  webviewRef,
  onCopy,
  onScreenshot
}: {
  grab: GrabModeHook
  payload: BrowserGrabPayload | null
  menuActionTakenRef: MutableRefObject<boolean>
  containerRef: RefObject<HTMLDivElement | null>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
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
    const webviewRect = webviewRef.current?.getBoundingClientRect()
    const containerRect = containerRef.current?.getBoundingClientRect()
    setPosition({
      left: (webviewRect?.left ?? 0) - (containerRect?.left ?? 0) + rect.x + rect.width / 2,
      top: (webviewRect?.top ?? 0) - (containerRect?.top ?? 0) + rect.y + rect.height / 2
    })
  }, [payload, webviewRef, containerRef])
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
