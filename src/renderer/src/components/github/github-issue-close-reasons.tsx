import { Ban, CheckCircle2, Copy } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { GitHubIssueCloseReason } from '../../../../shared/types'

export type CloseIssueReasonOption = {
  reason: GitHubIssueCloseReason
  label: string
  description: string
  icon: React.JSX.Element
}

export const CLOSE_ISSUE_REASONS: CloseIssueReasonOption[] = [
  {
    reason: 'completed',
    get label() {
      return translate(
        'auto.components.github.githubIssueCloseReasons.completed.label',
        'Close as completed'
      )
    },
    get description() {
      return translate(
        'auto.components.github.githubIssueCloseReasons.completed.description',
        'Done, closed, fixed, resolved'
      )
    },
    icon: <CheckCircle2 className="size-4 text-violet-500" />
  },
  {
    reason: 'not_planned',
    get label() {
      return translate(
        'auto.components.github.githubIssueCloseReasons.notPlanned.label',
        'Close as not planned'
      )
    },
    get description() {
      return translate(
        'auto.components.github.githubIssueCloseReasons.notPlanned.description',
        "Won't fix, can't repro, stale"
      )
    },
    icon: <Ban className="size-4 text-muted-foreground" />
  },
  {
    reason: 'duplicate',
    get label() {
      return translate(
        'auto.components.github.githubIssueCloseReasons.duplicate.label',
        'Close as duplicate'
      )
    },
    get description() {
      return translate(
        'auto.components.github.githubIssueCloseReasons.duplicate.description',
        'Duplicate of another issue'
      )
    },
    icon: <Copy className="size-4 text-muted-foreground" />
  }
]
