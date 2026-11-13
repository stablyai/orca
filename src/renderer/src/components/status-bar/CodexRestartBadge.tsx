import { RotateCcw } from 'lucide-react'
import React from 'react'
import { useAppStore } from '../../store'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { selectCodexStaleSessionCount } from './codex-restart-status-summary'

/** Selects a number so always-mounted surfaces re-render only when the count changes. */
export function useCodexStaleSessionCount(): number {
  return useAppStore(selectCodexStaleSessionCount)
}

export function codexRestartBadgeLabel(count: number, t: Translate): string {
  return t(
    'auto.components.status.bar.StatusBar.codexRestartBadgeLabel',
    '{{count}} Codex sessions need a restart',
    { count, defaultValue_one: '{{count}} Codex session needs a restart' }
  )
}

export function CodexRestartBadge({ count }: { count: number }): React.JSX.Element | null {
  const t = useTranslate()
  if (count === 0) {
    return null
  }
  const label = codexRestartBadgeLabel(count, t)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex h-3.5 shrink-0 items-center gap-0.5 rounded-full bg-status-warning px-1.5 text-[10px] font-bold leading-none tabular-nums text-status-warning-foreground"
    >
      <RotateCcw aria-hidden className="size-3" strokeWidth={2.5} />
      {count}
    </span>
  )
}
