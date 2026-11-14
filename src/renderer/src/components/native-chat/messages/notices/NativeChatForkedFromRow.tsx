import { GitFork } from 'lucide-react'
import { useContext } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatForkedFromContext } from '../actions/native-chat-fork-context'
import { ForkMarkedName } from '../../fork/ForkMarkedName'
import {
  NATIVE_CHAT_NOTICE_COPY,
  type NativeChatNoticeLook
} from '../../../../../../shared/native-chat/native-chat-notice'

/** The rule after a fork's inherited history: a pill that opens the source while it can be opened,
 *  plain words otherwise (source unknown to its host, or the pane cannot open chats now). */
export function NativeChatForkedFromRow({
  look
}: {
  look: Extract<NativeChatNoticeLook, { kind: 'forked-from' }>
}): React.JSX.Element {
  const t = useTranslate()
  const openForkSource = useContext(NativeChatForkedFromContext)
  const label = t('components.native-chat.notices.forkedFrom', NATIVE_CHAT_NOTICE_COPY.forkedFrom)
  const name = look.sourceForked ? (
    <ForkMarkedName name={look.sourceName} />
  ) : (
    <bdi>{look.sourceName}</bdi>
  )
  return (
    // Plain text with decorative rules: a separator role would hide the source button from screen readers.
    <div className="flex items-center gap-3 py-2 text-xs text-chat-foreground-faint">
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
      {look.sourceMissing ? (
        <span>
          {t(
            'components.native-chat.notices.forkedFromUnknown',
            NATIVE_CHAT_NOTICE_COPY.forkedFromUnknown
          )}
        </span>
      ) : openForkSource ? (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-[80%] items-center gap-1.5 rounded-full border border-border bg-foreground/5 px-2.5 py-1 text-xs hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openForkSource(look.sourceSessionId)}
        >
          <GitFork aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0">{label}</span>
          <span className="min-w-0 truncate font-semibold text-chat-foreground">{name}</span>
          <span aria-hidden className="inline-block shrink-0 rtl:rotate-180">
            ›
          </span>
        </button>
      ) : (
        <span className="min-w-0 truncate">
          {label} {name}
        </span>
      )}
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
    </div>
  )
}
