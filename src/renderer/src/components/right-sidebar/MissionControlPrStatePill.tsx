import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { HostedReviewState } from '../../../../shared/hosted-review'

// Why: PR state words are user-facing, so map them through the catalog rather
// than rendering the raw enum value.
function prStateLabel(state: HostedReviewState): string {
  switch (state) {
    case 'open':
      return translate('auto.components.right.sidebar.OrchestratorMissionControl.pr_open', 'open')
    case 'merged':
      return translate(
        'auto.components.right.sidebar.OrchestratorMissionControl.pr_merged',
        'merged'
      )
    case 'closed':
      return translate(
        'auto.components.right.sidebar.OrchestratorMissionControl.pr_closed',
        'closed'
      )
    case 'draft':
      return translate('auto.components.right.sidebar.OrchestratorMissionControl.pr_draft', 'draft')
  }
}

// Why: PR state reads as a colored pill in GitHub's convention. Colors live as
// `--pr-state-*` tokens in main.css (the same provider-parity exception the
// git-decoration palette makes), so they aren't raw inline hex here.
const PR_STATE_PILL_CLASS: Record<HostedReviewState, string> = {
  merged: 'bg-[var(--pr-state-merged)] text-white',
  open: 'bg-[var(--pr-state-open)] text-white',
  closed: 'bg-[var(--pr-state-closed)] text-white',
  draft: 'bg-[var(--pr-state-draft)] text-white'
}

export function PrStatePill({ state }: { state: HostedReviewState }): React.JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize leading-none',
        PR_STATE_PILL_CLASS[state]
      )}
    >
      {prStateLabel(state)}
    </span>
  )
}
