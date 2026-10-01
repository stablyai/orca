import { MessageSquare, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import {
  NATIVE_CHAT_EMPTY_STATE_COPY,
  NATIVE_CHAT_KEEPS_TRYING_COPY
} from '../../../../shared/native-chat-empty-state'
import type { NativeChatSession } from '../../../../shared/native-chat-types'

export function NativeChatEmptyState({
  kind,
  message,
  headline,
  headlineSaysUnread = false,
  agent,
  retrying = false
}: {
  kind: 'loading' | 'empty' | 'error' | 'not-agent'
  message?: string
  /** The chat's own sentence for the failure, said once: it takes the generic title's place. */
  headline?: string
  /** The headline already says the history didn't load, so the retrying line says only that
   *  Orca keeps trying. */
  headlineSaysUnread?: boolean
  agent?: NativeChatSession['agent']
  /** The read retries on its own (structured chat), so the error says so instead of pointing
   *  back to the terminal. */
  retrying?: boolean
}): React.JSX.Element {
  const copy = emptyStateCopy(kind, { message, headline, headlineSaysUnread }, agent, retrying)
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
      <p className="text-sm font-medium text-foreground">{copy.title}</p>
      {copy.subtitle ? (
        <p className="max-w-sm text-balance text-xs text-muted-foreground">{copy.subtitle}</p>
      ) : null}
    </div>
  )
}

function emptyStateCopy(
  kind: 'loading' | 'empty' | 'error' | 'not-agent',
  words: { message?: string; headline?: string; headlineSaysUnread?: boolean },
  agent?: NativeChatSession['agent'],
  retrying = false
): { title: string; subtitle: string | null } {
  switch (kind) {
    case 'loading':
      return {
        title: translate(
          'components.native-chat.state.loading.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.loading.title
        ),
        subtitle: translate(
          'components.native-chat.state.loading.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.loading.subtitle
        )
      }
    case 'error': {
      const retryingLine = !retrying
        ? null
        : words.headline && words.headlineSaysUnread
          ? translate(
              'components.native-chat.state.error.keepsTrying',
              NATIVE_CHAT_KEEPS_TRYING_COPY
            )
          : translate(
              'components.native-chat.state.error.retryingSubtitle',
              NATIVE_CHAT_EMPTY_STATE_COPY.retryingError.subtitle
            )
      if (words.headline) {
        return { title: words.headline, subtitle: retryingLine }
      }
      return {
        title: translate(
          'components.native-chat.state.error.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.error.title
        ),
        subtitle:
          retryingLine ??
          words.message ??
          translate(
            'components.native-chat.state.error.subtitle',
            NATIVE_CHAT_EMPTY_STATE_COPY.error.subtitle
          )
      }
    }
    case 'not-agent':
      return {
        title: translate(
          'components.native-chat.state.notAgent.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.notAgent.title
        ),
        subtitle: translate(
          'components.native-chat.state.notAgent.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.notAgent.subtitle
        )
      }
    case 'empty': {
      const agentName = agent ? formatAgentTypeLabel(agent) : 'the agent'
      return {
        title: translate(
          'components.native-chat.state.empty.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.title,
          { value0: agentName }
        ),
        subtitle: translate(
          'components.native-chat.state.empty.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.subtitle,
          { value0: agentName }
        )
      }
    }
  }
}
