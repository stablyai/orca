import React from 'react'
import { Bot, Monitor, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from './workspace-cleanup-host-identity'
import {
  getWorkspaceCleanupCandidateAccessibleName,
  getWorkspaceCleanupCandidateHostLabel
} from './workspace-cleanup-host-label'
import { WorkspaceCleanupMetadataChip } from './workspace-cleanup-metadata-chip'

/** Names the workspaces whose running agents a delete would stop, before anything is queued. */
export function WorkspaceCleanupConfirmStopAgents({
  candidates,
  onBack,
  onConfirm
}: {
  candidates: readonly WorkspaceCleanupCandidate[]
  onBack: () => void
  onConfirm: () => void
}): React.JSX.Element {
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
              <DialogTitle>
                {count === 1
                  ? translate(
                      'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_title',
                      'Stop this agent?'
                    )
                  : translate(
                      'components.workspace.cleanup.stopAgents.titleMany',
                      'Stop these agents?'
                    )}
              </DialogTitle>
              <DialogDescription className="mt-1.5">
                {count === 1
                  ? translate(
                      'components.workspace.cleanup.stopAgents.descriptionOne',
                      "Deleting will stop the agent's current work."
                    )
                  : translate(
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
            const hostLabel = getWorkspaceCleanupCandidateHostLabel(candidate)
            return (
              <li
                key={getWorkspaceCleanupCandidateIdentity(candidate)}
                aria-label={getWorkspaceCleanupCandidateAccessibleName(candidate)}
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
                    label={translate(
                      'components.workspace.cleanup.host.label',
                      'Host: {{value0}}',
                      { value0: hostLabel }
                    )}
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
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.74f6c16279',
              'Back'
            )}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            <Trash2 className="size-4" />
            {count === 1
              ? translate(
                  'components.workspace.cleanup.stopAgents.confirmOne',
                  'Stop agent and delete'
                )
              : translate(
                  'components.workspace.cleanup.stopAgents.confirm',
                  'Stop agents and delete'
                )}
          </Button>
        </DialogFooter>
      </div>
    </>
  )
}
