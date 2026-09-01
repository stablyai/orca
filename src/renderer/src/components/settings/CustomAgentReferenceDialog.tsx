import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { AgentReferenceOwnerKind } from '../../../../shared/agent-reference-snapshot'
import type { CustomTuiAgentId } from '../../../../shared/types'
import {
  groupReferencesByBucket,
  type ReferenceBucketGroup,
  type ReferenceOwnerBucket
} from './agent-reference-owner-buckets'
import { useAgentReferenceSummary } from './use-agent-reference-summary'

export type CustomAgentReferenceDialogAgent = {
  id: CustomTuiAgentId
  label: string
}

export type CustomAgentReferenceDialogProps = {
  open: boolean
  agent: CustomAgentReferenceDialogAgent
  /** True when opened from a deleted tombstone (the name stays reserved and there
   *  is no undelete); false when reviewing a live agent before deleting it. The
   *  opening surface owns this framing — the count-only summary can't derive it. */
  deleted: boolean
  onOpenChange: (open: boolean) => void
}

function ownerLabel(owner: AgentReferenceOwnerKind): string {
  switch (owner) {
    case 'default':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerDefault',
        'Default agent'
      )
    case 'quick-command':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerQuickCommand',
        'Quick commands'
      )
    case 'commit-message':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerCommitMessage',
        'Commit message'
      )
    case 'source-control-recipe':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerSourceControl',
        'Source Control actions'
      )
    case 'automation':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerAutomation',
        'Automations'
      )
    case 'session':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerSession',
        'Terminal sessions'
      )
    case 'background':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerBackground',
        'Background runs'
      )
    case 'orchestration':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerOrchestration',
        'Orchestration runs'
      )
    case 'workspace':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.ownerWorkspace',
        'Workspaces'
      )
  }
}

function bucketHeading(bucket: ReferenceOwnerBucket): string {
  switch (bucket) {
    case 'rebindable':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.rebindableHeading',
        'Can free the name'
      )
    case 'removable':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.removableHeading',
        'Removable records'
      )
    case 'retained':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.retainedHeading',
        "Can't be freed yet"
      )
  }
}

// Whether the name can be freed differs per bucket; copy is explicit so the view
// never implies a rebind that isn't possible (plan §219/§975).
function bucketHint(bucket: ReferenceOwnerBucket): string {
  switch (bucket) {
    case 'rebindable':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.rebindableHint',
        'Open each item and pick another agent to free the name.'
      )
    case 'removable':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.removableHint',
        'These clear when you delete the record they belong to.'
      )
    case 'retained':
      return translate(
        'auto.components.settings.CustomAgentReferenceDialog.retainedHint',
        'These hold the name until they finish or expire. The name is reserved until then.'
      )
  }
}

/** Read-only view of where a custom agent is still referenced, grouped by how the
 *  name can be freed (plan §975). Owner kind + count only — never the referencing
 *  item's prompt, config, or env. Opened from a deleted tombstone or from the
 *  delete confirmation's "Review references". */
export function CustomAgentReferenceDialog({
  open,
  agent,
  deleted,
  onOpenChange
}: CustomAgentReferenceDialogProps): React.JSX.Element {
  const { summary, loading } = useAgentReferenceSummary(agent.id, open)
  const groups = summary ? groupReferencesByBucket(summary) : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg"
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>
            {translate(
              'auto.components.settings.CustomAgentReferenceDialog.title',
              'References to {{label}}',
              { label: agent.label }
            )}
          </DialogTitle>
          <DialogDescription>
            {deleted
              ? translate(
                  'auto.components.settings.CustomAgentReferenceDialog.deletedIntro',
                  'This agent is deleted, but these saved items still reference it by name. The name stays reserved until every reference is freed. There is no undelete — its arguments and environment are gone.'
                )
              : translate(
                  'auto.components.settings.CustomAgentReferenceDialog.liveIntro',
                  'These saved items reference this agent. Review where it is used before you delete it.'
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 scrollbar-sleek overflow-y-auto px-6 py-4">
          {summary === null ? (
            <p className="text-sm text-muted-foreground">
              {loading
                ? translate(
                    'auto.components.settings.CustomAgentReferenceDialog.loading',
                    'Loading references…'
                  )
                : translate(
                    'auto.components.settings.CustomAgentReferenceDialog.unavailable',
                    'References could not be loaded. Reopen Settings to try again.'
                  )}
            </p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.settings.CustomAgentReferenceDialog.empty',
                'No saved items reference this agent.'
              )}
            </p>
          ) : (
            groups.map((group) => <ReferenceBucketSection key={group.bucket} group={group} />)
          )}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.CustomAgentReferenceDialog.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReferenceBucketSection({ group }: { group: ReferenceBucketGroup }): React.JSX.Element {
  return (
    <section className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{bucketHeading(group.bucket)}</h3>
        <p className="text-xs text-muted-foreground">{bucketHint(group.bucket)}</p>
      </div>
      <ul className="space-y-1">
        {group.owners.map((row) => (
          <li
            key={row.owner}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-1.5 text-sm"
          >
            <span>{ownerLabel(row.owner)}</span>
            <span className="text-muted-foreground">
              {row.unreadable
                ? translate(
                    'auto.components.settings.CustomAgentReferenceDialog.countUnavailable',
                    'Count unavailable'
                  )
                : String(row.count)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
