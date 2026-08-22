import type { ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatTerminalAttention as TerminalAttention } from './native-chat-terminal-attention'

export function NativeChatTerminalAttention({
  attention,
  onSwitchToTerminal,
  children
}: {
  attention: TerminalAttention | null
  onSwitchToTerminal?: () => void
  children: ReactNode
}): React.JSX.Element {
  if (!attention) {
    return <>{children}</>
  }

  return (
    <div
      role="alert"
      className="mx-3 mb-3 flex flex-wrap items-center gap-3 rounded-md border border-agent-question/30 bg-agent-question/[0.06] px-3 py-2.5"
    >
      <ShieldAlert className="size-4 shrink-0 text-agent-question" aria-hidden="true" />
      <div className="min-w-48 flex-1">
        <p className="text-sm font-medium text-foreground">
          {translate(
            'components.native-chat.terminalAttention.hooksReview.title',
            'Codex needs a security review'
          )}
        </p>
        <p className="text-xs leading-relaxed text-foreground/75">
          {translate(
            'components.native-chat.terminalAttention.hooksReview.description',
            'Review new or changed hooks before Chat can continue.'
          )}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!onSwitchToTerminal}
        className="shrink-0"
        onClick={onSwitchToTerminal}
      >
        {translate(
          'components.native-chat.terminalAttention.hooksReview.action',
          'Review in Terminal'
        )}
      </Button>
    </div>
  )
}
