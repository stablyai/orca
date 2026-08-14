import type {
  AgentSessionHandoffDirection,
  AgentSessionHandoffMode,
  AgentSessionHandoffStatus
} from '../../../../shared/agent-session-wire'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

type Props = {
  status: AgentSessionHandoffStatus | null
  isWorking: boolean
  hasPersistedTurn: boolean
  onRequest: (
    direction: AgentSessionHandoffDirection,
    mode: AgentSessionHandoffMode,
    action?: 'start' | 'cancel-queued' | 'retry' | 'recover'
  ) => void
}

function handoffStageCopy(status: AgentSessionHandoffStatus): string {
  if (status.stage === 'preparing') {
    return status.direction === 'to-tui'
      ? translate('components.native-chat.handoff.stage.finishingChat', 'Finishing chat session…')
      : translate(
          'components.native-chat.handoff.stage.finishingTerminal',
          'Finishing agent terminal…'
        )
  }
  if (status.stage === 'old-owner-stopped') {
    return status.direction === 'to-tui'
      ? translate('components.native-chat.handoff.stage.openingTerminal', 'Opening agent terminal…')
      : translate('components.native-chat.handoff.stage.resumingChat', 'Resuming chat session…')
  }
  if (status.stage === 'new-owner-proving') {
    return status.direction === 'to-tui'
      ? translate(
          'components.native-chat.handoff.stage.verifyingTerminal',
          'Verifying agent terminal…'
        )
      : translate('components.native-chat.handoff.stage.verifyingChat', 'Verifying chat session…')
  }
  if (status.stage === 'recovering') {
    return translate('components.native-chat.handoff.stage.recovering', 'Recovering agent session…')
  }
  if (status.stage === 'manual-recovery') {
    return translate(
      'components.native-chat.handoff.stage.manualRecovery',
      'Agent session needs recovery'
    )
  }
  return translate('components.native-chat.handoff.switchingOwner', 'Switching session owner…')
}

export function StructuredAgentSessionHandoffChrome({
  status,
  isWorking,
  hasPersistedTurn,
  onRequest
}: Props): React.JSX.Element | null {
  if (!status) {
    return null
  }
  const owner = status?.owner ?? 'native'
  const phase = status?.phase ?? 'idle'
  const switching = phase === 'switching' || phase === 'waiting-for-exit'
  return (
    <>
      <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-1.5">
        <Badge variant="outline">
          {switching
            ? translate('components.native-chat.handoff.mode.switching', 'Switching')
            : owner === 'tui'
              ? translate('components.native-chat.handoff.mode.terminal', 'Terminal')
              : translate('components.native-chat.handoff.mode.chat', 'Chat')}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          {phase === 'queued' && status?.direction ? (
            <>
              <span className="text-xs text-muted-foreground">
                {status.direction === 'to-tui'
                  ? translate(
                      'components.native-chat.handoff.switchingAfterTurn',
                      'Switching after this turn'
                    )
                  : translate(
                      'components.native-chat.handoff.returningAfterTurn',
                      'Returning after this turn'
                    )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onRequest(status.direction!, 'after-turn', 'cancel-queued')}
              >
                {translate('components.native-chat.handoff.cancel', 'Cancel')}
              </Button>
            </>
          ) : owner === 'native' && phase === 'idle' ? (
            isWorking ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onRequest('to-tui', 'after-turn')}
                >
                  {translate(
                    'components.native-chat.handoff.switchAfterTurn',
                    'Switch after this turn'
                  )}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => onRequest('to-tui', 'stop-turn')}
                >
                  {translate(
                    'components.native-chat.handoff.stopTurnAndSwitch',
                    'Stop turn and switch'
                  )}
                </Button>
              </>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={!hasPersistedTurn}
                      // A submitted turn can reach the host before isWorking updates; after-turn is immediate when idle.
                      onClick={() => onRequest('to-tui', 'after-turn')}
                    >
                      {translate('components.native-chat.handoff.openAgentTui', 'Open agent TUI')}
                    </Button>
                  </span>
                </TooltipTrigger>
                {!hasPersistedTurn ? (
                  <TooltipContent side="bottom" sideOffset={4}>
                    {translate(
                      'components.native-chat.handoff.sendFirst',
                      'Send a message first to open the agent TUI.'
                    )}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            )
          ) : owner === 'tui' && phase === 'idle' ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onRequest('to-native', 'after-turn')}
            >
              {isWorking
                ? translate(
                    'components.native-chat.handoff.returnAfterTurn',
                    'Return after this turn'
                  )
                : translate('components.native-chat.handoff.returnToChat', 'Return to chat')}
            </Button>
          ) : null}
        </div>
      </div>
      {owner === 'tui' && phase === 'idle' ? (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted px-3 py-2 text-xs">
          <span>
            {status?.hostLabel
              ? translate(
                  'components.native-chat.handoff.agentOpenOnHost',
                  'Agent is open in terminal on {{value0}}.',
                  { value0: status.hostLabel }
                )
              : translate('components.native-chat.handoff.agentOpen', 'Agent is open in terminal.')}
          </span>
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={() => onRequest('to-native', 'after-turn')}
          >
            {translate('components.native-chat.handoff.returnToChat', 'Return to chat')}
          </Button>
        </div>
      ) : null}
      {switching ? (
        <div className="border-b border-border bg-muted px-3 py-3 text-center text-sm text-muted-foreground">
          {phase === 'waiting-for-exit'
            ? translate(
                'components.native-chat.handoff.exitTerminal',
                'Exit the agent terminal to continue in chat.'
              )
            : status?.stage
              ? handoffStageCopy(status)
              : translate(
                  'components.native-chat.handoff.switchingOwner',
                  'Switching session owner…'
                )}
        </div>
      ) : null}
      {phase === 'failed' && status?.error ? (
        <div
          className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <div className="flex items-center justify-between gap-3">
            <span>{status.error.message}</span>
            {status.direction && status.error.canRetryProof ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onRequest(status.direction!, 'now', 'recover')}
              >
                {translate('components.native-chat.handoff.retryProof', 'Retry proof')}
              </Button>
            ) : status.direction && status.error.recoverableOwner !== 'none' ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onRequest(status.direction!, 'now', 'retry')}
              >
                {translate('components.native-chat.handoff.retry', 'Retry')}
              </Button>
            ) : null}
          </div>
          {status.error.details ? (
            <details className="mt-1">
              <summary>{translate('components.native-chat.handoff.details', 'Details')}</summary>
              <p className="mt-1 text-muted-foreground">{status.error.details}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
