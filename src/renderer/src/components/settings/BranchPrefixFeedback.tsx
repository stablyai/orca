import type { ReactNode } from 'react'
import {
  DEFAULT_BRANCH_PREFIX_SEPARATOR,
  getBranchPrefixIssue,
  getBranchPrefixSeparatorIssue,
  normalizeBranchPrefix
} from '../../../../shared/branch-prefix'
import { translate } from '@/i18n/i18n'

type BranchPrefixFeedbackProps = {
  rawPrefix: string
  separator?: string
}

export function BranchPrefixFeedback({
  rawPrefix,
  separator = DEFAULT_BRANCH_PREFIX_SEPARATOR
}: BranchPrefixFeedbackProps): ReactNode {
  const issue = getBranchPrefixIssue(rawPrefix)
  const sepIssue = getBranchPrefixSeparatorIssue(separator)
  const effectiveSep = separator || DEFAULT_BRANCH_PREFIX_SEPARATOR
  const normalized = normalizeBranchPrefix(rawPrefix, effectiveSep)

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
  } else if (sepIssue) {
    message = (
      <span className="text-destructive">
        {translate(
          'auto.components.settings.BranchPrefixFeedback.invalidSeparator',
          'Separator cannot contain spaces or special characters like ~ ^ : ? * [ \\'
        )}
      </span>
    )
  } else if (normalized) {
    message = (
      <span className="text-muted-foreground">
        {translate(
          'auto.components.settings.BranchPrefixFeedback.64d70b156a',
          'Branches will be named {{example}}',
          { example: `${normalized}${effectiveSep}feature` }
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

  // Reserve height so typing feedback cannot reflow the settings below.
  return <p className="min-h-4 text-xs">{message}</p>
}
