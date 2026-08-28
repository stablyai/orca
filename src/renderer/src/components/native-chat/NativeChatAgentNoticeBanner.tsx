import { AlertTriangle, Info, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

export type NativeChatAgentNoticeBannerProps = {
  message: NativeChatMessage
  text: string
  onSwitchToTerminal?: () => void
}

/** Inline card for a provider-authored system notice. */
export function NativeChatAgentNoticeBanner({
  message,
  text,
  onSwitchToTerminal
}: NativeChatAgentNoticeBannerProps): React.JSX.Element {
  const level = message.notice?.level ?? 'info'
  const needsAttention = level === 'warning' || level === 'error'
  const Icon = needsAttention ? AlertTriangle : Info

  return (
    <div
      role={needsAttention ? 'alert' : 'status'}
      className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-xs"
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 break-words text-foreground">{text}</p>
      </div>
      {needsAttention && onSwitchToTerminal ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onSwitchToTerminal}>
            <TerminalSquare />
            {translate(
              'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
              'Switch to terminal view'
            )}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
