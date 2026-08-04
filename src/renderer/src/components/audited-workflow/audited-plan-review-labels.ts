// Display labels for Codex plan-review verdicts.
//
// This is the ONE place the vocabulary/label gap is resolved. The durable
// vocabulary is the existing ReviewVerdict ('approved' | 'fixes_requested' |
// 'blocked'); the UI reads more naturally as "Accepted" / "Changes requested".
// Keeping the rename here — rather than introducing a second closed union —
// means nothing has to be mapped at a write site or bridged by a cast.
//
// Exhaustive switches with no `default`, so lint:switch-exhaustiveness fails if
// REVIEW_VERDICTS ever gains a member.
import { translate } from '@/i18n/i18n'
import type { ReviewVerdict } from '../../../../shared/audited-workflow-types'

export function getPlanReviewVerdictLabel(verdict: ReviewVerdict): string {
  switch (verdict) {
    case 'approved':
      return translate('auto.components.auditedWorkflow.verdict.approved', 'Accepted')
    case 'fixes_requested':
      return translate(
        'auto.components.auditedWorkflow.verdict.fixesRequested',
        'Changes requested'
      )
    case 'blocked':
      return translate('auto.components.auditedWorkflow.verdict.blocked', 'Blocked')
  }
}

export function getPlanReviewVerdictVariant(
  verdict: ReviewVerdict
): 'default' | 'secondary' | 'destructive' {
  switch (verdict) {
    case 'approved':
      return 'default'
    case 'fixes_requested':
      return 'secondary'
    case 'blocked':
      return 'destructive'
  }
}
