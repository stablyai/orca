import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

/** What a failed chat open knows: whether its agent is still resuming, the raw cause, and how to try again. */
export type ChatOpenUnavailable = {
  starting?: boolean
  detail?: string
  retry?: () => void
}

let chatOpenToastGeneration = 0
let chatOpenFailureCount = 0

export const chatOpenUnavailableText = {
  stillStarting: () =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.chatStillStarting',
      'This chat is still starting. Try again in a moment.'
    ),
  openFailed: () =>
    translate('auto.lib.activateAiVaultStructuredSession.chatOpenFailed', "Couldn't open chat")
}

/** `agent` leads the details, so a toast without the name still says whose chat failed. */
export function showChatOpenUnavailable(context: ChatOpenUnavailable = {}, agent?: string): void {
  const generation = chatOpenToastGeneration
  const retireToast = (): void => {
    if (chatOpenToastGeneration === generation) {
      chatOpenToastGeneration++
    }
  }
  const toastOptions = {
    id: `chat-open-unavailable-${generation}`,
    onDismiss: retireToast,
    onAutoClose: retireToast
  }
  if (context.starting) {
    toast.info(chatOpenUnavailableText.stillStarting(), {
      ...toastOptions,
      description: undefined,
      action: undefined
    })
    return
  }
  const { retry } = context
  const detail = [agent, context.detail].filter(Boolean).join('\n')
  const failureId = ++chatOpenFailureCount
  const onRetry = retry
    ? () => {
        // A fast failure must survive Sonner's exit animation for the old toast.
        retireToast()
        toast.dismiss(toastOptions.id)
        retry()
      }
    : undefined
  // Why re-shown on resize: sonner measures a toast only when it is shown, and a stale height
  // after opening the details pushes the actions under the status bar.
  const onDismiss = (): void => {
    toast.dismiss(toastOptions.id)
  }
  const onResize = (): void => {
    if (toast.getToasts().some((entry) => entry.id === toastOptions.id)) {
      show()
    }
  }
  function show(): void {
    // Never on a timer: the error stays until Dismiss or Retry.
    toast.custom(
      () => (
        <ChatOpenFailureCard
          key={failureId}
          detail={detail || undefined}
          onDismiss={onDismiss}
          onRetry={onRetry}
          onResize={onResize}
        />
      ),
      { ...toastOptions, duration: Number.POSITIVE_INFINITY, closeButton: false, unstyled: true }
    )
  }
  show()
}

export function ChatOpenFailureCard({
  detail,
  onDismiss,
  onRetry,
  onResize
}: {
  detail?: string
  onDismiss: () => void
  onRetry?: () => void
  onResize?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const card = cardRef.current
    if (!card) {
      return
    }
    let height = card.offsetHeight
    const observer = new ResizeObserver(() => {
      if (card.offsetHeight !== height) {
        height = card.offsetHeight
        onResize?.()
      }
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [onResize])
  return (
    <div
      ref={cardRef}
      role="alert"
      className="ml-auto w-[min(360px,calc(100vw-2rem))] rounded-xl border border-(--notice-border) bg-popover p-3.5 text-[13px] text-popover-foreground shadow-notice"
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
        <p data-title className="min-w-0 font-semibold leading-snug">
          {chatOpenUnavailableText.openFailed()}
        </p>
      </div>
      {detail ? (
        // pl-6 = icon + gap, so the disclosure and raw text start at the title's edge.
        <div className="mt-1 flex flex-col gap-1.5 pl-6 text-muted-foreground">
          <Button
            type="button"
            variant="disclosure"
            size="xs"
            className="-ml-1.5 self-start"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            aria-controls={detailId}
          >
            <ChevronRight
              className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
            />
            {open
              ? t('auto.lib.activateAiVaultStructuredSession.chatOpenHideDetails', 'Hide details')
              : t('auto.lib.activateAiVaultStructuredSession.chatOpenShowDetails', 'Show details')}
          </Button>
          {open ? (
            <p
              id={detailId}
              className="scrollbar-sleek max-h-20 select-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed"
            >
              {detail}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {t('auto.lib.activateAiVaultStructuredSession.chatOpenDismiss', 'Dismiss')}
        </Button>
        {onRetry ? (
          <Button type="button" size="sm" onClick={onRetry}>
            {t('auto.lib.activateAiVaultStructuredSession.chatOpenRetry', 'Retry')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
