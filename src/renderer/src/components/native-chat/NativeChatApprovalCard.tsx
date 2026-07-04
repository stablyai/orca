import { useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ChatApproval } from './native-chat-interactive-prompt'

export type NativeChatApprovalCardProps = {
  approval: ChatApproval
  /** Send the chosen option's literal string to the agent's PTY. */
  onChoose: (send: string) => void
}

/**
 * Native renderer for an agent tool-approval (PermissionRequest) as an
 * Allow/Deny card. Each button writes its option's literal `send` string back
 * to the agent (a number to allow; ESC to deny). The first option reads as the
 * affirmative action and gets the primary styling.
 */
export function NativeChatApprovalCard({
  approval,
  onChoose
}: NativeChatApprovalCardProps): React.JSX.Element {
  const [responding, setResponding] = useState(false)

  const choose = (send: string): void => {
    if (responding) {
      return
    }
    setResponding(true)
    onChoose(send)
  }

  return (
    <div className="border-b border-border bg-muted/30 px-3 py-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          <ShieldQuestion className="size-3.5 shrink-0" />
          <span>{translate('components.native-chat.approval.pending', 'Pending approval')}</span>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{approval.title}</p>
          {approval.detail ? (
            <p className="mt-0.5 break-words font-mono text-xs text-muted-foreground">
              {approval.detail}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {approval.options.map((opt, i) => (
            <Button
              key={`${opt.label}-${i}`}
              type="button"
              onClick={() => choose(opt.send)}
              disabled={responding}
              variant={i === 0 ? 'default' : 'outline'}
              size="sm"
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
