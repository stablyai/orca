import { ArrowRightLeft } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { ReactNode } from 'react'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'

/** A quiet line across the transcript with a label in the middle. */
export function NativeChatDividerRow({
  label,
  tone,
  handoff,
  children
}: {
  label: string
  tone?: 'error'
  handoff?: boolean
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 py-2 text-xs text-chat-foreground-faint"
    >
      <span className="h-px flex-1 bg-border" />
      <span className={`flex items-center gap-1${tone === 'error' ? ' text-destructive' : ''}`}>
        {handoff ? <ArrowRightLeft size={12} aria-hidden /> : null}
        {children ?? label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

export function NativeChatPendingHandoff({ from, to }: { from: string; to?: string }) {
  const t = useTranslate()
  if (!to) {
    return null
  }
  return (
    <NativeChatDividerRow
      handoff
      label={t('chat.providerSwitch.pending', 'Context handoff pending · {{from}} → {{to}}', {
        from,
        to: structuredAgentLabel(to)
      })}
    />
  )
}
