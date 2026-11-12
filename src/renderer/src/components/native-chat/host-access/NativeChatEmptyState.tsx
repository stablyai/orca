import { MessageSquare, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { NATIVE_CHAT_EMPTY_STATE_COPY } from '../../../../../shared/native-chat/native-chat-empty-state'
import type { NativeChatSession } from '../../../../../shared/native-chat/native-chat-types'

export function NativeChatEmptyState({
  kind,
  message,
  headline,
  agent,
  retrying = false
}: {
  kind: 'loading' | 'empty' | 'error' | 'not-agent'
  message?: string
  /** The chat's own sentence for the failure, said once: it takes the generic title's place. */
  headline?: string
  agent?: NativeChatSession['agent']
  /** Structured reads retry automatically; show a loading failure without directing users back to a terminal. */
  retrying?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const copy = emptyStateCopy(kind, { message, headline }, agent, retrying, t)
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div
        className={
          kind === 'error'
            ? 'flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive'
            : 'flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground'
        }
      >
        {kind === 'error' ? (
          <TriangleAlert className="size-6" />
        ) : (
          <MessageSquare className="size-6" />
        )}
      </div>
      <p className="text-sm font-medium text-chat-foreground-strong">{copy.title}</p>
      {copy.subtitle ? (
        <p className="max-w-sm text-balance text-xs text-chat-foreground-faint">{copy.subtitle}</p>
      ) : null}
    </div>
  )
}

function emptyStateCopy(
  kind: 'loading' | 'empty' | 'error' | 'not-agent',
  words: { message?: string; headline?: string },
  agent?: NativeChatSession['agent'],
  retrying = false,
  t: Translate = translate
): { title: string; subtitle: string | null } {
  switch (kind) {
    case 'loading':
      return {
        title: t(
          'components.native-chat.state.loading.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.loading.title
        ),
        subtitle: t(
          'components.native-chat.state.loading.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.loading.subtitle
        )
      }
    case 'error': {
      if (words.headline) {
        return { title: words.headline, subtitle: null }
      }
      return {
        title: t(
          'components.native-chat.state.error.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.error.title
        ),
        subtitle: retrying
          ? null
          : (words.message ??
            t(
              'components.native-chat.state.error.subtitle',
              NATIVE_CHAT_EMPTY_STATE_COPY.error.subtitle
            ))
      }
    }
    case 'not-agent':
      return {
        title: t(
          'components.native-chat.state.notAgent.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.notAgent.title
        ),
        subtitle: t(
          'components.native-chat.state.notAgent.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.notAgent.subtitle
        )
      }
    case 'empty': {
      const agentName = agent ? formatAgentTypeLabel(agent) : 'the agent'
      return {
        title: t(
          'components.native-chat.state.empty.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.title,
          { value0: agentName }
        ),
        subtitle: t(
          'components.native-chat.state.empty.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.subtitle,
          { value0: agentName }
        )
      }
    }
  }
}
