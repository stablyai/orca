// OWNER-TRANSFER: one line in the sidebar hover card of a cloud workspace that has had more than
// one owner, saying why personal secrets and sign-ins are not used there.
import React from 'react'
import { UserRoundCog } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudWorktreeOwnerChanged } from '@/components/cloud-workspaces/cloud-workspace-identity'
import {
  ownerChangedExplanation,
  ownerChangedLabel
} from '@/components/cloud-workspaces/owner-change-copy'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'

export function OwnerChangedDetails(): React.JSX.Element {
  const t = useTranslate()
  return (
    <WorktreeCardDetailSection>
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <UserRoundCog className="size-3" />
        <span>{ownerChangedLabel(t)}</span>
      </div>
      <WorktreeCardDetailSectionContent>
        <p className="px-1 text-xs text-muted-foreground">{ownerChangedExplanation(t)}</p>
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}

export function WorktreeCardOwnerChangedDetails({
  worktree
}: {
  worktree: { id: string; hostId?: string | null }
}): React.JSX.Element | null {
  return useCloudWorktreeOwnerChanged(worktree) ? <OwnerChangedDetails /> : null
}
