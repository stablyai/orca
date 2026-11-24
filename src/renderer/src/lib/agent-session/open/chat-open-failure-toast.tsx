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

let chatOpenToastGeneration = 0
let chatOpenFailureCount = 0

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
  toast.error(chatOpenUnavailableText.openFailed(), {
    ...toastOptions,
    description: detail ? (
      <ChatOpenFailureDetails key={++chatOpenFailureCount} detail={detail} />
    ) : undefined,
    action: retry
      ? {
          label: translate('auto.lib.activateAiVaultStructuredSession.chatOpenRetry', 'Retry'),
          onClick: () => {
            // A fast failure must survive Sonner's exit animation for the old toast.
            retireToast()
            retry()
          }
        }
      : undefined
  })
}

export function ChatOpenFailureDetails({ detail }: { detail: string }): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const detailId = useId()
  return (
    <div className="flex flex-col gap-1.5 text-muted-foreground">
      <Button
        type="button"
        variant="disclosure"
        size="xs"
        className="-ml-2 self-start"
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
          className="scrollbar-sleek max-h-20 select-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 font-mono text-xs leading-relaxed"
        >
          {detail}
        </p>
      ) : null}
    </div>
  )
}
