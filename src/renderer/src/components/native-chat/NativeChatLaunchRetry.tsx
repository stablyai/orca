import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'

export function NativeChatLaunchRetry({
  lifecycle,
  onRetry
}: {
  lifecycle: StructuredAgentSessionLaunchLifecycle | null
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
  return (
    <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-1 text-xs text-destructive">
      <span>{message}</span>
      <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
        <RotateCcw className="size-3" />
        {translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry')}
      </Button>
    </div>
  )
}
