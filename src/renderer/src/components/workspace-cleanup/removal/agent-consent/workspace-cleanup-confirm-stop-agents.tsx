import React from 'react'
import { Bot, Monitor, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceCleanupCandidate } from '../../../../../../shared/workspace-cleanup/workspace-cleanup'
import '../../candidate-evidence/workspace-cleanup-host-indexes'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import {
  getWorkspaceCleanupCandidateAccessibleName,
  getWorkspaceCleanupCandidateHostLabel
} from '../../candidate-list/workspace-cleanup-host-label'
import { WorkspaceCleanupMetadataChip } from '../../candidate-list/workspace-cleanup-metadata-chip'

export function WorkspaceCleanupConfirmStopAgents({
  candidates,
  onBack,
  onConfirm
}: {
  candidates: readonly WorkspaceCleanupCandidate[]
  onBack: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const count = candidates.length
  return (
    <>
      <div className="border-b border-border px-5 py-4">
        <DialogHeader>
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-destructive/25 bg-destructive/10 text-destructive">
              <Bot className="size-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle>{t('common.delete', 'Delete')}</DialogTitle>
              <DialogDescription className="mt-1.5">
                <span className="block">
                  {t('components.workspace.cleanup.browse.workspaceCount', '{{count}} workspaces', {
                    count,
                    defaultValue_one: '{{count}} workspace'
                  })}
                </span>
                {count === 1
                  ? t(
                      'components.workspace.cleanup.stopAgents.descriptionOne',
                      "Deleting will stop the agent's current work."
                    )
                  : t(
                      'components.workspace.cleanup.stopAgents.descriptionMany',
                      "Deleting will stop these agents' current work."
                    )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul>
          {candidates.map((candidate, index) => {
            const hostLabel = getWorkspaceCleanupCandidateHostLabel(candidate, t)
            return (
              <li
                key={getWorkspaceCleanupCandidateIdentity(candidate)}
                aria-label={getWorkspaceCleanupCandidateAccessibleName(candidate, t)}
                className={cn(
                  'border-b border-border/60 px-5 py-2.5',
                  index === candidates.length - 1 && 'border-b-0'
                )}
              >
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {candidate.displayName}
                  </span>
                  <WorkspaceCleanupMetadataChip
                    icon={Monitor}
                    label={t('components.workspace.cleanup.host.label', 'Host: {{value0}}', {
                      value0: hostLabel
                    })}
                    value={hostLabel}
                  />
                </div>
                <div className="mt-0.5 min-w-0 truncate text-xs text-muted-foreground">
                  {candidate.repoName}
                </div>
              </li>
            )
          })}
        </ul>
      </ScrollArea>
      <div className="border-t border-border px-5 py-3">
        <DialogFooter>
          <Button variant="outline" onClick={onBack}>
            {t('auto.components.workspace.cleanup.WorkspaceCleanupDialog.74f6c16279', 'Back')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            <Trash2 className="size-4" />
            {t('common.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </div>
    </>
  )
}
