import type { Dispatch, SetStateAction } from 'react'
import { cn } from '@/lib/class-names'
import { Crosshair } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { SendNotesSlot } from '@/components/editor/review-note-delivery/SendNotesButton'
import { BrowserAnnotationSendMenu } from '../../annotate/delivery/BrowserAnnotationSendMenu'
import type { BrowserAnnotationsClearRequest } from '../../annotate/delivery/use-browser-page-annotation-send'
import { browserAnnotationLimitMessage } from '../../annotate/delivery/browser-annotation-limit-message'
import {
  isBrowserAnnotationPageFull,
  type BrowserGrabPayload,
  type GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { GrabModeHook } from '../../annotate/grab/useGrabMode'

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
  includePageDetails,
  handleIncludePageDetailsChange,
  handleBrowserAnnotationsSentToAgent,
  handleBrowserAnnotationsHandedOff,
  handleCopyBrowserAnnotations,
  sendableAnnotationCount,
  createBrowserAnnotationsClearRequest,
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
  includePageDetails: boolean
  handleIncludePageDetailsChange: (include: boolean) => void
  handleBrowserAnnotationsSentToAgent: () => void
  handleBrowserAnnotationsHandedOff: (delivered: Promise<unknown>) => void
  handleCopyBrowserAnnotations: () => void
  sendableAnnotationCount: number
  createBrowserAnnotationsClearRequest: () => BrowserAnnotationsClearRequest
  setPendingAnnotationPayload: Dispatch<SetStateAction<BrowserGrabPayload | null>>
}): React.JSX.Element | null {
  const t = useTranslate()
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
            aria-label={t('auto.components.browser.pane.BrowserPane.2fdca7df09', 'Dismiss')}
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
          <span className={cn('min-w-0 truncate', grabIntent !== 'annotate' && 'flex-1')}>
            {grab.state === 'error'
              ? t(
                  'auto.components.browser.pane.BrowserPane.4328a0a062',
                  'Grab failed: {{value0}}',
                  { value0: grab.error ?? 'Unknown error' }
                )
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
          {grabIntent === 'annotate' ? (
            <SendNotesSlot className="justify-end">
              <BrowserAnnotationSendMenu
                annotationCount={browserAnnotationsLength}
                sendableCount={sendableAnnotationCount}
                open={annotationBannerSendOpen}
                onOpenChange={handleAnnotationBannerSendOpenChange}
                worktreeId={worktreeId}
                groupId={activeGroupId ?? worktreeId}
                prompt={browserAnnotationsPrompt}
                includePageDetails={includePageDetails}
                onIncludePageDetailsChange={handleIncludePageDetailsChange}
                onPromptDelivered={handleBrowserAnnotationsSentToAgent}
                onPromptHandedOff={handleBrowserAnnotationsHandedOff}
                onCopy={handleCopyBrowserAnnotations}
                createClearRequest={createBrowserAnnotationsClearRequest}
                size="sm"
              />
            </SendNotesSlot>
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
      ) : null}
    </>
  )
}
