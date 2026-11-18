import { cn } from '@/lib/class-names'
import { Crosshair } from 'lucide-react'
import { SendNotesSlot } from '@/components/editor/review-note-delivery/SendNotesButton'
import { useTranslate } from '@/i18n/use-translate'
import { BrowserAnnotationSendMenu } from './delivery/BrowserAnnotationSendMenu'
import { browserAnnotationLimitMessage } from './delivery/browser-annotation-limit-message'
import { isBrowserAnnotationPageFull } from '../../../../../shared/browser/element-grab/browser-grab-types'
import type { useBrowserGuestAnnotateTools } from './use-browser-guest-annotate-tools'

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
    sendableAnnotationCount,
    createBrowserAnnotationsClearRequest
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
      <span className={cn('min-w-0 truncate', grabIntent !== 'annotate' && 'flex-1')}>
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
  )
}
