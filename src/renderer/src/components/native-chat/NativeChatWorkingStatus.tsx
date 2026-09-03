import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'

export function NativeChatWorkingStatus({
  startedAt,
  thinking,
  workedSeconds,
  expanded = false,
  onToggleExpanded
}: {
  startedAt: number | null
  thinking: boolean
  workedSeconds?: number | null
  expanded?: boolean
  onToggleExpanded?: () => void
}): React.JSX.Element {
  // Why: elapsed seconds is ordinary render dataflow, not an external system.
  // The shared 1s clock is visibility-gated and collapses every in-flight turn
  // onto one tick, instead of one interval plus one commit per turn.
  const counting = !thinking && workedSeconds == null
  const now = useNow(1_000, counting)
  // Why: preserves the old effect's `startedAt ?? Date.now()` epoch for the
  // single frame before the turn's startedAt lands.
  const [mountedAt] = useState(() => Date.now())
  const elapsedSeconds = counting
    ? Math.max(0, Math.floor((now - (startedAt ?? mountedAt)) / 1000))
    : 0

  const label =
    workedSeconds != null
      ? translate('components.native-chat.status.workedFor', 'Worked for {{value0}} seconds', {
          value0: workedSeconds
        })
      : thinking
        ? translate('components.native-chat.status.thinking', 'Thinking')
        : translate('components.native-chat.status.workingFor', 'Working for {{value0}} seconds', {
            value0: elapsedSeconds
          })

  const className = `flex min-h-8 items-center gap-1 text-sm text-muted-foreground${thinking ? '' : ' border-b border-border'}`
  const caret =
    workedSeconds != null ? (
      <ChevronRight
        className={`size-3.5 transition-transform${expanded ? ' rotate-90' : ''}`}
        aria-hidden="true"
      />
    ) : null
  if (workedSeconds != null && onToggleExpanded) {
    return (
      <button
        type="button"
        className={`${className} w-full text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70`}
        aria-label={translate('components.native-chat.status.toggleDetails', 'Toggle turn details')}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        <span>{label}</span>
        {caret}
      </button>
    )
  }

  return (
    <div
      className={className}
      aria-label={translate('components.native-chat.status.responding', 'Agent is responding')}
      aria-live="polite"
    >
      <span className={thinking ? 'animate-pulse' : undefined}>{label}</span>
      {caret}
    </div>
  )
}
