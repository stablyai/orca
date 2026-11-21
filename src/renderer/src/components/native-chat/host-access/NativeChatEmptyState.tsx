import { MessageSquare, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useScrollEdgeFades } from '@/lib/list-interaction/use-scroll-edge-fades'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { NATIVE_CHAT_EMPTY_STATE_COPY } from '../../../../../shared/native-chat/native-chat-empty-state'
import type { NativeChatSession } from '../../../../../shared/native-chat/native-chat-types'
import './native-chat-empty-state.css'

/** Who an empty chat introduces in the agent's place, e.g. a bot. */
export type NativeChatPersona = { icon: React.ReactNode; name: string; subtitle: string }

export function NativeChatEmptyState({
  kind,
  message,
  headline,
  agent,
  persona,
  retrying = false
}: {
  kind: 'loading' | 'empty' | 'error' | 'not-agent'
  message?: string
  /** The chat's own sentence for the failure, said once: it takes the generic title's place. */
  headline?: string
  agent?: NativeChatSession['agent']
  persona?: NativeChatPersona | null
  /** Structured reads retry automatically; show a loading failure without directing users back to a terminal. */
  retrying?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const fades = useScrollEdgeFades<HTMLDivElement>()
  const shownPersona = kind === 'empty' ? persona : null
  const copy = shownPersona
    ? {
        title: t(
          'components.native-chat.state.empty.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.title,
          {
            value0: shownPersona.name
          }
        ),
        subtitle: shownPersona.subtitle
      }
    : emptyStateCopy(kind, { message, headline }, agent, retrying, t)
  return (
    <div className="native-chat-empty-state h-full min-h-0 w-full overflow-hidden has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring">
      <div
        ref={fades.ref}
        role={fades.scrollable ? 'region' : undefined}
        aria-label={fades.scrollable ? copy.title : undefined}
        tabIndex={fades.scrollable ? 0 : undefined}
        className={cn(
          'scrollbar-sleek flex h-full min-h-0 w-full flex-col justify-center-safe overflow-y-auto focus-visible:outline-none',
          fades.className
        )}
      >
        <div className="native-chat-empty-state-content flex w-full shrink-0 flex-col items-center gap-3 p-6 text-center">
          {shownPersona ? (
            shownPersona.icon
          ) : (
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
          )}
          <p className="text-sm font-medium text-chat-foreground-strong">{copy.title}</p>
          {copy.subtitle ? (
            <p className="max-w-sm text-balance text-xs text-chat-foreground-faint">
              {copy.subtitle}
            </p>
          ) : null}
        </div>
      </div>
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
