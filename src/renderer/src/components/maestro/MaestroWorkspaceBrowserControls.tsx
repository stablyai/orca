import { Loader2 } from 'lucide-react'
import type { RefObject } from 'react'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import { BrowserNavigationControlRow } from '@/components/browser-pane/assemble-chrome/browser-navigation-control-row'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'

export type MaestroBrowserNavigationMethod =
  | 'browser.goto'
  | 'browser.back'
  | 'browser.forward'
  | 'browser.reload'

export function maestroBrowserAddressValue(url: string): string {
  return redactKagiSessionToken(url.trim()) || 'about:blank'
}

export function maestroBrowserControlError(error: unknown): string {
  if (
    hasRuntimeRpcErrorCode(error, 'browser_tab_not_found') ||
    hasRuntimeRpcErrorCode(error, 'browser_no_tab')
  ) {
    return translate(
      'auto.components.maestro.MaestroWorkspaceBrowserPreview.pageUnavailable',
      'This Browser page is no longer available.'
    )
  }
  if (
    hasRuntimeRpcErrorCode(error, 'method_not_found') ||
    hasRuntimeRpcErrorCode(error, 'capability_unsupported')
  ) {
    return translate(
      'auto.components.maestro.MaestroWorkspaceBrowserPreview.controlsUpdateRequired',
      'Browser controls require a newer peer.'
    )
  }
  return translate(
    'auto.components.maestro.MaestroWorkspaceBrowserPreview.controlsUnavailable',
    'Browser controls are temporarily unavailable. The last confirmed frame remains visible.'
  )
}

export const maestroBrowserHistoryMethods: readonly Exclude<
  MaestroBrowserNavigationMethod,
  'browser.goto'
>[] = ['browser.back', 'browser.forward', 'browser.reload']

export function maestroBrowserNavigationAction(
  method: Exclude<MaestroBrowserNavigationMethod, 'browser.goto'>
): 'browser.back' | 'browser.forward' | 'browser.reload' {
  return method
}

export function MaestroWorkspaceBrowserControls({
  pageId,
  addressBarRef,
  addressBarValue,
  controlsDisabled,
  controlStatus,
  navigationNotice,
  unavailable,
  navigationPending,
  onAddressBarChange,
  onAddressBarFocus,
  onAddressBarBlur,
  onSubmitAddressBar,
  onInteract,
  onNavigate
}: {
  pageId: string
  addressBarRef: RefObject<HTMLInputElement | null>
  addressBarValue: string
  controlsDisabled: boolean
  controlStatus: string | null
  navigationNotice: string | null
  unavailable: boolean
  navigationPending: boolean
  onAddressBarChange: (value: string) => void
  onAddressBarFocus: (input: HTMLInputElement) => void
  onAddressBarBlur: () => void
  onSubmitAddressBar: () => void
  onInteract: () => void
  onNavigate: (method: MaestroBrowserNavigationMethod, url?: string) => void
}): React.JSX.Element {
  return (
    <div
      className="shrink-0"
      onPointerDown={(event) => {
        event.stopPropagation()
        onInteract()
      }}
    >
      <BrowserNavigationControlRow
        controls={{
          canGoBack: !controlsDisabled,
          canGoForward: !controlsDisabled,
          canReload: !controlsDisabled,
          loading: navigationPending,
          goBack: () => onNavigate('browser.back'),
          goForward: () => onNavigate('browser.forward'),
          reload: () => onNavigate('browser.reload'),
          navigate: (url) => onNavigate('browser.goto', url)
        }}
        showTourAnchors={false}
        addressSlot={
          <form
            className="flex min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              onSubmitAddressBar()
            }}
          >
            <Input
              ref={addressBarRef}
              value={addressBarValue}
              onChange={(event) => onAddressBarChange(event.target.value)}
              onFocus={(event) => onAddressBarFocus(event.currentTarget)}
              onBlur={onAddressBarBlur}
              aria-label={translate(
                'auto.components.maestro.MaestroWorkspaceBrowserPreview.address',
                'Browser address'
              )}
              aria-describedby={controlStatus ? `maestro-browser-status-${pageId}` : undefined}
              data-orca-browser-address-bar="true"
              disabled={controlsDisabled}
              className="h-7 rounded-full bg-muted/50 px-3 text-xs"
              spellCheck={false}
            />
          </form>
        }
      />
      {controlStatus || navigationNotice ? (
        <p
          id={`maestro-browser-status-${pageId}`}
          className="border-b border-border/70 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground"
          role={unavailable || navigationNotice ? 'status' : undefined}
        >
          {navigationNotice ?? controlStatus}
        </p>
      ) : null}
    </div>
  )
}

export function MaestroWorkspaceBrowserViewport({
  pageId,
  preview,
  state,
  imageRef,
  onPointerDown,
  onPointerUp,
  onWheel,
  onKeyDown
}: {
  pageId: string
  preview: string | null
  state: 'loading' | 'ready' | 'reconnecting'
  imageRef: RefObject<HTMLImageElement | null>
  onPointerDown: (event: React.PointerEvent<HTMLImageElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLImageElement>) => void
  onWheel: (event: React.WheelEvent<HTMLImageElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => void
}): React.JSX.Element {
  if (state === 'ready' && preview) {
    return (
      <img
        ref={imageRef}
        src={preview}
        alt={translate(
          'auto.components.maestro.MaestroWorkspaceBrowserPreview.0b65d32766',
          'Interactive Browser page {{value0}}',
          { value0: pageId }
        )}
        className="min-h-0 flex-1 cursor-default bg-white object-fill outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        data-browser-page-id={pageId}
        data-maestro-browser-interactive=""
        draggable={false}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      />
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-4 text-center text-xs text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      <p className="mt-2">
        {state === 'loading'
          ? translate(
              'auto.components.maestro.MaestroWorkspaceBrowserPreview.3e7cc4bc3a',
              'Attaching the interactive Browser page…'
            )
          : translate(
              'auto.components.maestro.MaestroWorkspaceBrowserPreview.reconnecting',
              'Reconnecting the interactive Browser page…'
            )}
      </p>
    </div>
  )
}
