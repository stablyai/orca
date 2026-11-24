import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
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

const CHAT_OPEN_TOAST_ID = 'chat-open-unavailable'

export const chatOpenUnavailableText = {
  stillStarting: () =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.chatStillStarting',
      'This chat is still starting. Try again in a moment.'
    ),
  openFailed: () =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.chatOpenFailed',
      "Couldn't open this chat."
    )
}

export function showChatOpenUnavailable(context: ChatOpenUnavailable = {}): void {
  // One id keeps repeated clicks to one toast; sonner merges updates, so clear what this one lacks.
  if (context.starting) {
    toast.info(chatOpenUnavailableText.stillStarting(), {
      id: CHAT_OPEN_TOAST_ID,
      description: undefined,
      action: undefined
    })
    return
  }
  const { retry, detail } = context
  toast.error(chatOpenUnavailableText.openFailed(), {
    id: CHAT_OPEN_TOAST_ID,
    description: detail ? <ChatOpenFailureDetails detail={detail} /> : undefined,
    action: retry
      ? {
          label: translate('auto.lib.activateAiVaultStructuredSession.chatOpenRetry', 'Retry'),
          onClick: retry
        }
      : undefined
  })
}

export function ChatOpenFailureDetails({ detail }: { detail: string }): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const detailId = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
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
          className="scrollbar-sleek max-h-20 select-text overflow-auto break-words rounded-md bg-muted/40 px-2 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground"
        >
          {detail}
        </p>
      ) : null}
    </div>
  )
}
