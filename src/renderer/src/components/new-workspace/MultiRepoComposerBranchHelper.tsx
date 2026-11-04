import React from 'react'
import { getMultiRepoBranchHelper } from './multi-repo-composer-status'
import type { MultiRepoComposerView } from './use-multi-repo-composer'

export function MultiRepoComposerBranchHelper({
  multiRepo,
  name
}: {
  multiRepo: MultiRepoComposerView | undefined
  name: string
}): React.JSX.Element | null {
  if (!multiRepo?.active || multiRepo.blockedCount !== 0) {
    return null
  }
  return (
    <p className="-mt-2 text-[11px] text-muted-foreground">
      {getMultiRepoBranchHelper(name, multiRepo.selectedProjectIds.length, 0)}
    </p>
  )
}
