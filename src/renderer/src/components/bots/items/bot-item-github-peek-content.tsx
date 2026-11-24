import { Check, CircleDot, X } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function checksLabel(t: Translate, checks: string | null): string | null {
  if (checks === 'success') {
    return t('browser.newTab.checks.passing', 'Checks passing')
  }
  if (checks === 'failure') {
    return t('browser.newTab.checks.failing', 'Checks failing')
  }
  if (checks === 'pending') {
    return t('browser.newTab.checks.pending', 'Checks pending')
  }
  return null
}

/** A PR's checks in words, for its GitHub card: a hover must not read a failing PR as healthy. */
export function useGitHubChecksMeta(checks: string | null): ReactNode {
  const t = useTranslate()
  const label = checksLabel(t, checks)
  return useMemo(() => {
    if (!label) {
      return null
    }
    const Icon = checks === 'success' ? Check : checks === 'failure' ? X : CircleDot
    const tone =
      checks === 'success'
        ? 'text-status-success'
        : checks === 'failure'
          ? 'text-destructive'
          : 'text-status-warning'
    return (
      <span className={cn('flex shrink-0 items-center gap-0.5', tone)}>
        <Icon aria-hidden strokeWidth={2.5} className="size-3" />
        {label}
      </span>
    )
  }, [checks, label])
}

/** A GitHub link's card before, or without, its lookup: what its chip or row already knows, never a
 *  bare web page preview. A failed lookup keeps only the title above the card's failure line: the
 *  state and checks the chip last read may since have changed. */
export function useGitHubLinkPeekFallback(
  title: string,
  tip: string
): { pending: ReactNode; failed: ReactNode } {
  return useMemo(() => {
    const name = <div className="line-clamp-2 text-sm font-semibold text-foreground">{title}</div>
    return {
      pending: (
        <div className="flex flex-col gap-1">
          {name}
          <div className="text-xs text-muted-foreground">{tip}</div>
        </div>
      ),
      failed: name
    }
  }, [title, tip])
}
