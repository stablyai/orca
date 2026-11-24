import { useMemo, type ReactNode } from 'react'
import type { Translate } from '@/i18n/use-translate'

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

/** A GitHub link's card before, or without, its lookup: what its chip or row already knows, never a
 *  bare web page preview. A failed lookup keeps only the title above the card's failure line: the
 *  state and checks the chip last read may since have changed. */
export function useGitHubLinkPeekFallback(
  title: string,
  tip: string
): { pending: ReactNode; failed: ReactNode } {
  return useMemo(() => {
    const name = (
      // Whole, never clamped: the card is the row's only way to its full title.
      <div className="text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{title}</div>
    )
    return {
      pending: (
        <div className="flex flex-col gap-1">
          {name}
          <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{tip}</div>
        </div>
      ),
      failed: name
    }
  }, [title, tip])
}

/** Retries a failed GitHub card's lookup from its focused link or row. */
export const GITHUB_RETRY_KEY = 'r'
