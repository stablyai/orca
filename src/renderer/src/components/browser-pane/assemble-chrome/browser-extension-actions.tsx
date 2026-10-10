import { useCallback, useEffect, useRef, useState } from 'react'
import { Puzzle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { BrowserExtensionAction } from '../../../../../shared/browser-guest-events'
import { webviewRegistry } from '../host-guest/webview-registry'

/** The guest WebContents id, which main names the page by in extension events. */
function useGuestWebContentsId(browserPageId: string, loading: boolean): number | null {
  const [id, setId] = useState<number | null>(null)
  useEffect(() => {
    const webview = webviewRegistry.get(browserPageId)
    if (!webview) {
      return
    }
    const read = (): void => {
      try {
        setId(webview.getWebContentsId())
      } catch {
        // Not attached yet; dom-ready reads it again.
      }
    }
    read()
    webview.addEventListener('dom-ready', read)
    return () => {
      webview.removeEventListener('dom-ready', read)
    }
  }, [browserPageId, loading])
  return id
}

/** The page's extension buttons; each opens its extension's popup against this page. */
export function BrowserExtensionActions({
  browserPageId,
  loading
}: {
  browserPageId: string
  /** Why a dependency: each load is when a new or replaced guest has become readable. */
  loading: boolean
}): React.JSX.Element | null {
  const [actions, setActions] = useState<BrowserExtensionAction[]>([])
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const guestId = useGuestWebContentsId(browserPageId, loading)

  useEffect(() => {
    let current = true
    const refresh = (): void =>
      void window.api.browser.extensionActions({ browserPageId }).then((next) => {
        if (current) {
          setActions(next)
        }
      })
    refresh()
    const unsubscribe = window.api.browser.onExtensionActionsChanged(refresh)
    return () => {
      current = false
      unsubscribe()
    }
  }, [browserPageId, guestId])

  const activate = useCallback(
    (extensionId: string) => {
      const rect = buttons.current.get(extensionId)?.getBoundingClientRect()
      if (rect) {
        const anchor = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        window.api.browser.activateExtensionAction({ browserPageId, extensionId, anchor })
      }
    },
    [browserPageId]
  )

  useEffect(
    () =>
      window.api.browser.onExtensionActionRequested((event) => {
        if (event.tabId === guestId) {
          activate(event.extensionId)
        }
      }),
    [guestId, activate]
  )

  if (actions.length === 0) {
    return null
  }
  return (
    <div className="flex items-center" data-testid="browser-extension-actions">
      {actions.map((action) => (
        <Button
          key={action.extensionId}
          ref={(node) => {
            if (node) {
              buttons.current.set(action.extensionId, node)
            } else {
              buttons.current.delete(action.extensionId)
            }
          }}
          size="icon"
          variant="ghost"
          className="relative h-7 w-7"
          title={action.title}
          aria-label={action.title}
          data-extension-id={action.extensionId}
          disabled={!action.enabled}
          onClick={() => activate(action.extensionId)}
          onContextMenu={(event) => {
            event.preventDefault()
            window.api.browser.showExtensionActionMenu({
              browserPageId,
              extensionId: action.extensionId
            })
          }}
        >
          {action.iconDataUrl ? (
            <img src={action.iconDataUrl} alt="" className="size-4" draggable={false} />
          ) : (
            <Puzzle className="size-4" />
          )}
          {action.badgeText ? (
            <span
              className="pointer-events-none absolute right-0 bottom-0 max-w-full truncate rounded-sm bg-muted-foreground px-0.5 text-[9px] leading-3 text-background"
              // Extensions pick their badge colors; unset ones keep the toolbar's.
              style={{
                backgroundColor: action.badgeBackgroundColor ?? undefined,
                color: action.badgeTextColor ?? undefined
              }}
            >
              {action.badgeText}
            </span>
          ) : null}
        </Button>
      ))}
    </div>
  )
}
