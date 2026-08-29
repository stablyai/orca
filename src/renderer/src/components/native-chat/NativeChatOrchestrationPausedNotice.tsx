import { PauseCircle } from 'lucide-react'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'

export function NativeChatOrchestrationPausedNotice({
  dispatchStatus
}: {
  dispatchStatus?: AgentStatusOrchestrationContext['dispatchStatus']
}): React.JSX.Element | null {
  if (dispatchStatus !== 'pending' && dispatchStatus !== 'dispatched') {
    return null
  }

  return (
    <div
      data-orchestration-paused="true"
      className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      <PauseCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <Badge variant="secondary">
          {translate('components.native-chat.orchestrationPaused.label', 'Orchestration paused')}
        </Badge>
        <p>
          {translate(
            'components.native-chat.orchestrationPaused.message',
            'Structured Chat blocks terminal prompts and sends. Orchestration messages remain queued; switch to Terminal, then check the Orca inbox with'
          )}{' '}
          <code className="font-mono text-foreground">
            {translate(
              'components.native-chat.orchestrationPaused.command',
              'orca orchestration check'
            )}
          </code>
          .
        </p>
      </div>
    </div>
  )
}
