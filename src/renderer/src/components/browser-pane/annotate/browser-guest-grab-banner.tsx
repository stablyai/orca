import { cn } from '@/lib/class-names'
import { CircleCheck, Copy, Crosshair, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  BrowserAnnotationSendMenuContent,
  browserAnnotationCopyTooltip
} from './delivery/BrowserAnnotationSendMenuContent'
import { browserAnnotationLimitMessage } from './delivery/browser-annotation-limit-message'
import { isBrowserAnnotationPageFull } from '../../../../../shared/browser/element-grab/browser-grab-types'
import type { useBrowserGuestAnnotateTools } from './use-browser-guest-annotate-tools'
import { preventAgentSendTargetOutsideDismiss } from './delivery/prevent-agent-send-target-outside-dismiss'

/** The armed picker's guidance and note actions, shown under every surface's toolbar. */
export function BrowserGuestGrabBanner({
  tools,
  worktreeId
}: {
  tools: Pick<
    ReturnType<typeof useBrowserGuestAnnotateTools>,
    'grab' | 'grabAnnotations' | 'annotationSend'
  >
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const { grab } = tools
  const { grabIntent, pendingAnnotationPayload, setPendingAnnotationPayload } =
    tools.grabAnnotations
  const {
    browserAnnotations,
    annotationBannerSendOpen,
    handleAnnotationBannerSendOpenChange,
    activeGroupId,
    browserAnnotationsPrompt,
    includePageDetails,
    handleIncludePageDetailsChange,
    handleBrowserAnnotationsSentToAgent,
    handleBrowserAnnotationsHandedOff,
    handleCopyBrowserAnnotations,
    browserAnnotationsCopied,
    handleClearBrowserAnnotations
  } = tools.annotationSend
  const browserAnnotationsLength = browserAnnotations.length
  if (grab.state === 'idle') {
    return null
  }
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-foreground/90',
        grab.state === 'error' ? 'bg-destructive/10' : 'bg-accent'
      )}
    >
      <Crosshair
        className={cn(
          'size-3 shrink-0',
          grab.state === 'error' ? 'text-destructive' : 'text-muted-foreground'
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        {grab.state === 'error'
          ? t('auto.components.browser.pane.BrowserPane.4328a0a062', 'Grab failed: {{value0}}', {
              value0: grab.error ?? 'Unknown error'
            })
          : grabIntent === 'annotate'
            ? pendingAnnotationPayload
              ? t(
                  'auto.components.browser.pane.BrowserPane.b733a91bd9',
                  'Add feedback for the selected element.'
                )
              : isBrowserAnnotationPageFull(browserAnnotationsLength)
                ? browserAnnotationLimitMessage(t)
                : browserAnnotationsLength === 1
                  ? t(
                      'auto.components.browser.pane.BrowserPane.074f0ed10b',
                      '{{value0}} annotation ready. Select another element or copy all feedback.',
                      { value0: browserAnnotationsLength }
                    )
                  : browserAnnotationsLength > 0
                    ? t(
                        'auto.components.browser.pane.BrowserPane.a2164a6e5a',
                        '{{value0}} annotations ready. Select another element or copy all feedback.',
                        { value0: browserAnnotationsLength }
                      )
                    : t(
                        'auto.components.browser.pane.BrowserPane.777b5bc4ec',
                        'Click an element to add feedback for the agent.'
                      )
            : grab.state === 'confirming'
              ? t(
                  'auto.components.browser.pane.BrowserPane.e852e20cea',
                  'Copied — press S to screenshot, or select another element'
                )
              : t(
                  'auto.components.browser.pane.BrowserPane.168350ae6a',
                  'Click or hover an element, then press C to copy or S to screenshot.'
                )}
      </span>
      {grabIntent === 'annotate' && browserAnnotationsLength > 0 ? (
        <>
          <DropdownMenu
            modal={false}
            open={annotationBannerSendOpen}
            onOpenChange={handleAnnotationBannerSendOpenChange}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="xs"
                    variant="outline"
                    className="h-6 gap-1.5"
                    disabled={!browserAnnotationsPrompt}
                  >
                    <Send className="size-3" />
                    {t('auto.components.browser.pane.BrowserPane.ac39b9366b', 'Send')}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {t(
                  'auto.components.browser.pane.BrowserPane.95af781091',
                  'Send feedback to an agent'
                )}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              className="min-w-[180px]"
              onInteractOutside={preventAgentSendTargetOutsideDismiss}
              onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
            >
              <BrowserAnnotationSendMenuContent
                worktreeId={worktreeId}
                groupId={activeGroupId ?? worktreeId}
                prompt={browserAnnotationsPrompt}
                includePageDetails={includePageDetails}
                onIncludePageDetailsChange={handleIncludePageDetailsChange}
                onPromptDelivered={handleBrowserAnnotationsSentToAgent}
                onPromptHandedOff={handleBrowserAnnotationsHandedOff}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant="outline"
                className="h-6 gap-1.5"
                onClick={handleCopyBrowserAnnotations}
              >
                {browserAnnotationsCopied ? (
                  <CircleCheck className="size-3" />
                ) : (
                  <Copy className="size-3" />
                )}
                {browserAnnotationsCopied
                  ? t('auto.components.browser.pane.BrowserPane.6f4ab3592b', 'Copied')
                  : t('auto.components.browser.pane.BrowserPane.499b31b84e', 'Copy All')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {browserAnnotationCopyTooltip(includePageDetails, t)}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                onClick={handleClearBrowserAnnotations}
                aria-label={t(
                  'auto.components.browser.pane.BrowserPane.734e4343ec',
                  'Clear browser annotations'
                )}
              >
                <Trash2 className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.components.browser.pane.BrowserPane.11c5084aa2', 'Clear annotations')}
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
      <button
        className="ml-auto shrink-0 rounded px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => {
          setPendingAnnotationPayload(null)
          grab.cancel()
        }}
      >
        {t('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
      </button>
    </div>
  )
}
