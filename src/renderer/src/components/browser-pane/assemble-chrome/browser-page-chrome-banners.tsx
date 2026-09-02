import type { Dispatch, SetStateAction } from 'react'
import { cn } from '@/lib/utils'
import { CircleCheck, Copy, Crosshair, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { BrowserAnnotationSendMenuContent } from '../annotate/BrowserAnnotationSendMenuContent'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import type { GrabModeHook } from '../annotate/useGrabMode'
import { preventAgentSendTargetOutsideDismiss } from '../annotate/prevent-agent-send-target-outside-dismiss'
import type { GrabIntent } from '../describe-page/browser-page-types'

export function BrowserPageChromeBanners({
  resourceNotice,
  setResourceNotice,
  grab,
  grabIntent,
  pendingAnnotationPayload,
  browserAnnotationsLength,
  annotationBannerSendOpen,
  handleAnnotationBannerSendOpenChange,
  worktreeId,
  activeGroupId,
  browserAnnotationsPrompt,
  handleBrowserAnnotationsSentToAgent,
  handleCopyBrowserAnnotations,
  browserAnnotationsCopied,
  handleClearBrowserAnnotations,
  setPendingAnnotationPayload
}: {
  resourceNotice: string | null
  setResourceNotice: Dispatch<SetStateAction<string | null>>
  grab: GrabModeHook
  grabIntent: GrabIntent
  pendingAnnotationPayload: BrowserGrabPayload | null
  browserAnnotationsLength: number
  annotationBannerSendOpen: boolean
  handleAnnotationBannerSendOpenChange: (open: boolean) => void
  worktreeId: string
  activeGroupId: string | undefined
  browserAnnotationsPrompt: string
  handleBrowserAnnotationsSentToAgent: () => void
  handleCopyBrowserAnnotations: () => void
  browserAnnotationsCopied: boolean
  handleClearBrowserAnnotations: () => void
  setPendingAnnotationPayload: Dispatch<SetStateAction<BrowserGrabPayload | null>>
}): React.JSX.Element | null {
  if (!resourceNotice && grab.state === 'idle') {
    return null
  }

  return (
    <>
      {resourceNotice ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-background px-3 py-1.5 text-xs text-muted-foreground">
          <span>{resourceNotice}</span>
          <button
            type="button"
            onClick={() => setResourceNotice(null)}
            className="shrink-0 text-muted-foreground/60 hover:text-foreground"
            aria-label={translate('auto.components.browser.pane.BrowserPane.2fdca7df09', 'Dismiss')}
          >
            ✕
          </button>
        </div>
      ) : null}
      {grab.state !== 'idle' ? (
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
              ? translate(
                  'auto.components.browser.pane.BrowserPane.4328a0a062',
                  'Grab failed: {{value0}}',
                  { value0: grab.error ?? 'Unknown error' }
                )
              : grabIntent === 'annotate'
                ? pendingAnnotationPayload
                  ? translate(
                      'auto.components.browser.pane.BrowserPane.b733a91bd9',
                      'Add feedback for the selected element.'
                    )
                  : browserAnnotationsLength === 1
                    ? translate(
                        'auto.components.browser.pane.BrowserPane.074f0ed10b',
                        '{{value0}} annotation ready. Select another element or copy all feedback.',
                        { value0: browserAnnotationsLength }
                      )
                    : browserAnnotationsLength > 0
                      ? translate(
                          'auto.components.browser.pane.BrowserPane.a2164a6e5a',
                          '{{value0}} annotations ready. Select another element or copy all feedback.',
                          { value0: browserAnnotationsLength }
                        )
                      : translate(
                          'auto.components.browser.pane.BrowserPane.777b5bc4ec',
                          'Click an element to add feedback for the agent.'
                        )
                : grab.state === 'confirming'
                  ? translate(
                      'auto.components.browser.pane.BrowserPane.e852e20cea',
                      'Copied — press S to screenshot, or select another element'
                    )
                  : translate(
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
                      <Button size="xs" variant="outline" className="h-6 gap-1.5">
                        <Send className="size-3" />
                        {translate('auto.components.browser.pane.BrowserPane.ac39b9366b', 'Send')}
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate(
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
                    onPromptDelivered={handleBrowserAnnotationsSentToAgent}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
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
                  ? translate('auto.components.browser.pane.BrowserPane.6f4ab3592b', 'Copied')
                  : translate('auto.components.browser.pane.BrowserPane.499b31b84e', 'Copy All')}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    onClick={handleClearBrowserAnnotations}
                    aria-label={translate(
                      'auto.components.browser.pane.BrowserPane.734e4343ec',
                      'Clear browser annotations'
                    )}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate(
                    'auto.components.browser.pane.BrowserPane.11c5084aa2',
                    'Clear annotations'
                  )}
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
            {translate('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
          </button>
        </div>
      ) : null}
    </>
  )
}
