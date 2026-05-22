import { cn } from '@/lib/utils'

export type IntegrationStatusTone = 'connected' | 'attention' | 'neutral'

const TONE_CLASSES: Record<IntegrationStatusTone, { pill: string; dot: string }> = {
  connected: {
    pill: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    dot: 'bg-emerald-500'
  },
  attention: {
    pill: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500'
  },
  neutral: {
    pill: 'border-border bg-background text-muted-foreground',
    dot: 'bg-muted-foreground'
  }
}

export function IntegrationStatusPill({
  tone,
  children
}: {
  tone: IntegrationStatusTone
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE_CLASSES[tone].pill
      )}
    >
      <span className={cn('size-1.5 rounded-full', TONE_CLASSES[tone].dot)} />
      {children}
    </span>
  )
}
