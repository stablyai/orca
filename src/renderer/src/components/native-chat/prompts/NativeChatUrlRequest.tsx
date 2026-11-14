import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { readApprovalUrl } from '../../../../../shared/agent-session/agent-session-approval-subject'
import type {
  AgentJournalApprovalItem,
  AgentJournalUrlApprovalSubject
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'

/** Opens only in the system browser, outside anything Orca or an agent can read. */
export function openUrlRequestPage(url: string): void {
  const target = readApprovalUrl(url)
  if (target) {
    openAppHttpLink(target.href, { destination: 'system' })
  }
}

/** Where the page goes: its host to judge it by, then the whole link. */
export function NativeChatUrlTarget({ url }: { url: string }): React.JSX.Element | null {
  const target = readApprovalUrl(url)
  if (!target) {
    return null
  }
  return (
    <div data-native-chat-url-target="true" className="min-w-0 space-y-0.5 font-mono">
      <p className="truncate text-xs text-foreground">{target.host}</p>
      <p className="break-all text-2xs text-muted-foreground">{target.href}</p>
    </div>
  )
}

/** An opened URL request in the transcript: waiting on the agent, or finished. */
export function NativeChatUrlRequestReceipt({
  body,
  subject,
  finished
}: {
  body: AgentJournalApprovalItem
  subject: AgentJournalUrlApprovalSubject
  finished: boolean
}): React.JSX.Element {
  const t = useTranslate()
  if (finished) {
    return (
      <div
        data-native-chat-receipt="url-finished"
        className="truncate rounded-lg border border-input bg-card px-3 py-2 text-xs text-muted-foreground"
      >
        {body.description
          ? t('components.native-chat.urlRequest.finishedWith', 'Sign-in finished · {{message}}', {
              message: body.description
            })
          : t('components.native-chat.urlRequest.finished', 'Sign-in finished')}
      </div>
    )
  }
  const target = readApprovalUrl(subject.url)
  return (
    <div
      data-native-chat-receipt="url-opened"
      className="space-y-1 rounded-lg border border-input bg-card px-4 py-3"
    >
      <p className="text-sm font-semibold text-foreground">
        {t('components.native-chat.urlRequest.title', 'Sign-in requested')}
      </p>
      {body.description ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {body.description}
        </p>
      ) : null}
      {target ? (
        <p className="truncate font-mono text-xs text-muted-foreground">{target.host}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-muted-foreground">
          {t(
            'components.native-chat.urlRequest.opened',
            'Opened the sign-in page in your browser.'
          )}
        </span>
        {target ? (
          <Button variant="ghost" size="xs" onClick={() => openUrlRequestPage(target.href)}>
            {t('components.native-chat.urlRequest.openAgain', 'Open again')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
