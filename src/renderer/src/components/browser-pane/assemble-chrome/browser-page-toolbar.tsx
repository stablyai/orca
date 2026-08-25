import type { Dispatch, RefObject, SetStateAction } from 'react'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  SquareCode
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { translate } from '@/i18n/i18n'
import type { BrowserReloadTrigger } from '../navigate/browser-reload-action'
import BrowserAddressBar from './BrowserAddressBar'
import { BrowserImportHintButton } from './BrowserImportHintButton'
import { BrowserToolbarMenu } from './BrowserToolbarMenu'
import { MarkupDrawButton } from '../annotate/MarkupDrawButton'
import { destroyPersistentWebview } from '../host-guest/webview-registry'
import { readBrowserHtmlArtifactRequest } from '../describe-page/browser-artifact-upload'
import type { GrabModeHook } from '../annotate/useGrabMode'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import type { GrabIntent } from '../describe-page/browser-page-types'

export function BrowserPageToolbar({
  browserPageId,
  workspaceId,
  sessionProfileId,
  viewportPresetId,
  isActive,
  canGoBack,
  canGoForward,
  loading,
  webviewRef,
  reloadMenuOpen,
  setReloadMenuOpen,
  reloadButtonLabel,
  reloadButtonLabelKind,
  reloadShortcut,
  hardReloadShortcut,
  runReloadTrigger,
  addressBarValue,
  setAddressBarValue,
  submitAddressBar,
  navigateToUrl,
  addressBarInputRef,
  dismissAddressBarSuggestionsRef,
  grab,
  grabIntent,
  startGrabIntent,
  isBlankTab,
  markupIsActive,
  markupStart,
  markupCancel,
  grabElementShortcut,
  browserAnnotationsLength,
  shareableArtifactFile,
  currentBrowserUrl,
  externalUrl
}: {
  browserPageId: string
  workspaceId: string
  sessionProfileId: string | null
  viewportPresetId: BrowserViewportPresetId | null
  isActive: boolean
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  webviewRef: RefObject<Electron.WebviewTag | null>
  reloadMenuOpen: boolean
  setReloadMenuOpen: Dispatch<SetStateAction<boolean>>
  reloadButtonLabel: string
  reloadButtonLabelKind: 'stop' | 'retry' | 'reload'
  reloadShortcut: string
  hardReloadShortcut: string
  runReloadTrigger: (trigger: BrowserReloadTrigger) => void
  addressBarValue: string
  setAddressBarValue: Dispatch<SetStateAction<string>>
  submitAddressBar: () => void
  navigateToUrl: (url: string) => void
  addressBarInputRef: RefObject<HTMLInputElement | null>
  dismissAddressBarSuggestionsRef: RefObject<(() => void) | null>
  grab: GrabModeHook
  grabIntent: GrabIntent
  startGrabIntent: (intent: GrabIntent) => void
  isBlankTab: boolean
  markupIsActive: boolean
  markupStart: () => Promise<void>
  markupCancel: () => void
  grabElementShortcut: string
  browserAnnotationsLength: number
  shareableArtifactFile: { filePath: string } | null
  currentBrowserUrl: string
  externalUrl: string | null
}): React.JSX.Element {
  return (
    <div
      className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5"
      data-contextual-tour-target="browser-toolbar"
    >
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => webviewRef.current?.goBack()}
        disabled={!canGoBack}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => webviewRef.current?.goForward()}
        disabled={!canGoForward}
      >
        <ArrowRight className="size-4" />
      </Button>
      <DropdownMenu modal={false} open={reloadMenuOpen} onOpenChange={setReloadMenuOpen}>
        {/* Why: suppress the tooltip while the menu is open — both anchor below the button and would overlap. */}
        <Tooltip open={reloadMenuOpen ? false : undefined}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label={reloadButtonLabel}
                // Why: preventDefault suppresses Radix's open-on-left-click (composeEventHandlers skips its
                // handler once defaultPrevented), keeping left-click on the primary action and the menu on right-click.
                onPointerDown={(e) => {
                  if (e.button === 0) {
                    e.preventDefault()
                  }
                }}
                // Why: same trick for Radix's open-on-Enter/Space, which would otherwise preventDefault the
                // synthesized click and strand keyboard users. ArrowDown still falls through to open the menu.
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    runReloadTrigger('button')
                  }
                }}
                onClick={() => runReloadTrigger('button')}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setReloadMenuOpen(true)
                }}
              >
                {loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {reloadButtonLabel}
            {/* Why: the chord maps to plain reload(), which is not what Stop or Retry do — only hint when they match. */}
            {reloadShortcut && reloadButtonLabelKind === 'reload' ? ` · ${reloadShortcut}` : ''}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" alignOffset={-4}>
          <DropdownMenuItem onClick={() => runReloadTrigger('reload')}>
            {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
            <DropdownMenuShortcut>{reloadShortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => runReloadTrigger('hard-reload')}>
            {translate('auto.components.browser.pane.BrowserPane.a1f3c2e4b5', 'Hard Reload')}
            <DropdownMenuShortcut>{hardReloadShortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BrowserAddressBar
        value={addressBarValue}
        onChange={setAddressBarValue}
        onSubmit={submitAddressBar}
        onNavigate={navigateToUrl}
        inputRef={addressBarInputRef}
        dismissSuggestionsRef={dismissAddressBarSuggestionsRef}
      />

      <BrowserImportHintButton profileId={sessionProfileId} />

      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              size="icon"
              variant={grab.state !== 'idle' && grabIntent === 'copy' ? 'default' : 'ghost'}
              className={cn(
                'h-8 w-8',
                grab.state !== 'idle' &&
                  grabIntent === 'copy' &&
                  'bg-foreground/80 text-background hover:bg-foreground/90'
              )}
              onClick={() => startGrabIntent('copy')}
              disabled={isBlankTab || markupIsActive}
              aria-label={translate(
                'auto.components.browser.pane.BrowserPane.fdfc7fe0ef',
                'Grab page element'
              )}
              data-contextual-tour-target="browser-grab-control"
            >
              <Crosshair className="size-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate(
            'auto.components.browser.pane.BrowserPane.acbe79fd01',
            'Grab page element ({{value0}})',
            { value0: grabElementShortcut }
          )}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          {/* Why: disabled <button> drops hover events, so wrap in a span so the tooltip trigger still fires. */}
          <span className="inline-flex">
            <Button
              size="icon"
              variant={grab.state !== 'idle' && grabIntent === 'annotate' ? 'default' : 'ghost'}
              className={cn(
                'relative h-8 w-8',
                grab.state !== 'idle' &&
                  grabIntent === 'annotate' &&
                  'bg-foreground/80 text-background hover:bg-foreground/90'
              )}
              onClick={() => startGrabIntent('annotate')}
              disabled={isBlankTab || markupIsActive}
              aria-label={translate(
                'auto.components.browser.pane.BrowserPane.fc9be38f6f',
                'Annotate page element'
              )}
              data-contextual-tour-target="browser-annotation-control"
            >
              <MessageSquarePlus className="size-4" />
              {browserAnnotationsLength > 0 ? (
                <span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
                  {browserAnnotationsLength}
                </span>
              ) : null}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate(
            'auto.components.browser.pane.BrowserPane.fc9be38f6f',
            'Annotate page element'
          )}
        </TooltipContent>
      </Tooltip>

      <MarkupDrawButton
        onClick={() => (markupIsActive ? markupCancel() : void markupStart())}
        disabled={isBlankTab || grab.state !== 'idle'}
        active={markupIsActive}
        surfaceActive={isActive}
      />

      {shareableArtifactFile ? (
        <ArtifactPublishButton
          sourceKey={shareableArtifactFile.filePath}
          className="h-7 w-7"
          createRequest={() => readBrowserHtmlArtifactRequest(currentBrowserUrl)}
        />
      ) : null}

      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => void window.api.browser.openDevTools({ browserPageId })}
        title={translate(
          'auto.components.browser.pane.BrowserPane.ec75d0c412',
          'Open browser devtools'
        )}
      >
        <SquareCode className="size-4" />
      </Button>

      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => {
          if (!externalUrl) {
            return
          }
          void window.api.shell.openUrl(externalUrl)
        }}
        title={translate(
          'auto.components.browser.pane.BrowserPane.0f41bf80c7',
          'Open in default browser'
        )}
        disabled={!externalUrl}
      >
        <ExternalLink className="size-4" />
      </Button>

      <BrowserToolbarMenu
        currentProfileId={sessionProfileId}
        workspaceId={workspaceId}
        browserPageId={browserPageId}
        viewportPresetId={viewportPresetId}
        onDestroyWebview={() => destroyPersistentWebview(browserPageId)}
        isActive={isActive}
      />
    </div>
  )
}
