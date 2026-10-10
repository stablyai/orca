import type { ReactNode } from 'react'
import {
  getBranchPrefixIssue,
  normalizeBranchPrefix,
  type GitUsernamePrefixOmission
} from '../../../../shared/branch-prefix'
import { translate } from '@/i18n/i18n'

type BranchPrefixFeedbackProps = {
  rawPrefix: string
  omission?: GitUsernamePrefixOmission | null
}

export function BranchPrefixFeedback({
  rawPrefix,
  omission = null
}: BranchPrefixFeedbackProps): ReactNode {
  const issue = getBranchPrefixIssue(rawPrefix)
  const normalized = normalizeBranchPrefix(rawPrefix)

  let message: ReactNode = null
  if (issue) {
    message = (
      <span className="text-destructive">
        {translate(
          'auto.components.settings.BranchPrefixFeedback.6c40c0908f',
          'Prefix cannot contain spaces or special characters like ~ ^ : ? * [ \\'
        )}
      </span>
    )
  } else if (normalized) {
    message = (
      <span className="text-muted-foreground">
        {translate(
          'auto.components.settings.BranchPrefixFeedback.64d70b156a',
          'Branches will be named {{example}}',
          { example: `${normalized}/feature` }
        )}
      </span>
    )
  } else if (omission === 'lowercase-lock') {
    message = (
      <span className="text-muted-foreground">
        {translate(
          'auto.components.settings.BranchPrefixFeedback.c478cf4ec7',
          'No prefix will be applied because lowercasing this username ends in .lock, which Git rejects.'
        )}
      </span>
    )
  } else if (rawPrefix.trim()) {
    message = (
      <span className="text-muted-foreground">
        {translate(
          'auto.components.settings.BranchPrefixFeedback.808f9a726e',
          'No prefix will be applied'
        )}
      </span>
    )
  }

  // Reserve a line of height so the message swapping in/out as the user types
  // does not reflow the settings list below it.
  return <p className="min-h-4 text-xs">{message}</p>
}
