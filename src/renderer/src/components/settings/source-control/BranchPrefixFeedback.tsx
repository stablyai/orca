import type { ReactNode } from 'react'
import {
  getBranchPrefixIssue,
  normalizeBranchPrefix
} from '../../../../../shared/git/branches/branch-prefix'
import { useTranslate } from '@/i18n/use-translate'

type BranchPrefixFeedbackProps = {
  rawPrefix: string
}

export function BranchPrefixFeedback({ rawPrefix }: BranchPrefixFeedbackProps): ReactNode {
  const t = useTranslate()
  const issue = getBranchPrefixIssue(rawPrefix)
  const normalized = normalizeBranchPrefix(rawPrefix)

  let message: ReactNode = null
  if (issue) {
    message = (
      <span className="text-destructive">
        {t(
          'auto.components.settings.BranchPrefixFeedback.6c40c0908f',
          'Prefix cannot contain spaces or special characters like ~ ^ : ? * [ \\'
        )}
      </span>
    )
  } else if (normalized) {
    message = (
      <span className="text-muted-foreground">
        {t(
          'auto.components.settings.BranchPrefixFeedback.64d70b156a',
          'Branches will be named {{example}}',
          { example: `${normalized}/feature` }
        )}
      </span>
    )
  } else if (rawPrefix.trim()) {
    message = (
      <span className="text-muted-foreground">
        {t('auto.components.settings.BranchPrefixFeedback.808f9a726e', 'No prefix will be applied')}
      </span>
    )
  }

  // Reserve height so typing feedback cannot reflow the settings below.
  return <p className="min-h-4 text-xs">{message}</p>
}
