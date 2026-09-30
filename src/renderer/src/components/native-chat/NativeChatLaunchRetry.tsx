import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'
import { agentSessionRefusalCauseParts } from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'

export function NativeChatLaunchRetry({
  lifecycle,
  failure = null,
  agentLabel,
  onRetry
}: {
  lifecycle: StructuredAgentSessionLaunchLifecycle | null
  /** Names the agent in a start failure's words. */
  agentLabel?: string
  /** The host's refusal behind the failed start; its message is never shown. */
  failure?: AgentSessionWriteRefusal | null
  onRetry: () => void
}): React.JSX.Element | null {
  if (lifecycle !== 'failed' && lifecycle !== 'visibility-unknown') {
    return null
  }
  const message =
    lifecycle === 'failed'
      ? translate(
          'auto.components.native.chat.NativeChatLaunchRetry.failed',
          'Chat could not be started.'
        )
      : translate(
          'auto.components.native.chat.NativeChatLaunchRetry.unknown',
          'Chat connection could not be confirmed.'
        )
  const cause =
    lifecycle === 'failed' && failure
      ? agentSessionWriteNoticeText(
          agentSessionRefusalCauseParts(failure, agentLabel ? { agentName: agentLabel } : {})
        )
      : ''
  return (
    <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-1 text-xs text-destructive">
      <span className="min-w-0 break-words">
        {message}
        {cause ? ` ${cause}` : null}
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
        <RotateCcw className="size-3" />
        {translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry')}
      </Button>
    </div>
  )
}
