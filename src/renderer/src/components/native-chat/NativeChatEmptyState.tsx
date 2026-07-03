import { MessageSquare, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import type { NativeChatSession } from '../../../../shared/native-chat-types'

export function NativeChatEmptyState({
  kind,
  message,
  agent
}: {
  kind: 'loading' | 'empty' | 'error' | 'not-agent'
  message?: string
  agent?: NativeChatSession['agent']
}): React.JSX.Element {
  const copy = emptyStateCopy(kind, message, agent)
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
  message?: string,
  agent?: NativeChatSession['agent']
): { title: string; subtitle: string | null } {
  switch (kind) {
    case 'loading':
      return {
        title: translate('components.native-chat.state.loading.title', 'Loading conversation…'),
        subtitle: translate(
          'components.native-chat.state.loading.subtitle',
          'Reading the agent transcript.'
        )
      }
    case 'error':
      return {
        title: translate('components.native-chat.state.error.title', 'Could not load conversation'),
        subtitle:
          message ??
          translate(
            'components.native-chat.state.error.subtitle',
            'The transcript could not be read. Toggle back to the terminal to keep working.'
          )
      }
    case 'not-agent':
      return {
        title: translate('components.native-chat.state.notAgent.title', 'No conversation here'),
        subtitle: translate(
          'components.native-chat.state.notAgent.subtitle',
          'This terminal is not running a recognized coding agent.'
        )
      }
    case 'empty': {
      const agentName = agent ? formatAgentTypeLabel(agent) : 'the agent'
      return {
        title: translate(
          'components.native-chat.state.empty.title',
          'Start a chat with {{value0}}',
          { value0: agentName }
        ),
        subtitle: translate(
          'components.native-chat.state.empty.subtitle',
          'Ask {{value0}} to inspect code, explain output, or make a change.',
          { value0: agentName }
        )
      }
    }
  }
}
