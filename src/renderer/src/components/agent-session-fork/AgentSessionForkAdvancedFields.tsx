import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import type { AgentSessionForkBase } from '@/lib/agent-session-fork-flow'
import { useRepoMap, useWorktreesForRepo } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

function pickerValue(base: AgentSessionForkBase, parentValue: string): string {
  if (base.kind === 'ref') {
    return base.ref
  }
  // Why: '' is the picker's "Project default" row, so only a real repo-default base may show it.
  return base.kind === 'repo-default' ? '' : parentValue
}

function baseFromPicker(value: string, parentValue: string): AgentSessionForkBase {
  if (!value) {
    return { kind: 'repo-default' }
  }
  // Why: an attached worktree's branch tip is its HEAD, so picking it keeps the carry available.
  return value === parentValue ? { kind: 'parent-commit' } : { kind: 'ref', ref: value }
}

function startFromHelp(
  parentBranch: string | null,
  parentCommit: string | null,
  workspace: string
): string {
  if (!parentBranch && parentCommit) {
    return translate(
      'components.agentSessionFork.startFromHelpCommit',
      'Default: the current commit ({{commit}}).',
      { commit: parentCommit }
    )
  }
  return translate(
    'components.agentSessionFork.startFromHelp',
    'Default: the current commit of {{branch}}.',
    { branch: parentBranch ?? workspace }
  )
}

// Why: same "Advanced" disclosure as the composer and add-host dialogs (ghost button + chevron).
export function AgentSessionForkAdvancedFields({
  open,
  onOpenChange,
  repoId,
  base,
  parentBranch,
  parentCommit,
  workspace,
  onBaseChange,
  disabled
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoId: string
  base: AgentSessionForkBase
  parentBranch: string | null
  parentCommit: string | null
  workspace: string
  onBaseChange: (base: AgentSessionForkBase) => void
  disabled: boolean
}): React.JSX.Element {
  const repoMap = useRepoMap()
  const worktrees = useWorktreesForRepo(repoId)
  const labelId = useId()
  // Why: a detached parent has no branch; show its short commit rather than "Project default".
  const parentValue =
    parentBranch ??
    parentCommit ??
    translate('components.agentSessionFork.currentCommit', 'Current commit')
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {translate('components.agentSessionFork.advanced', 'Advanced')}
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1 pt-3">
          <Label id={labelId}>
            {translate('components.agentSessionFork.startFrom', 'Start from')}
          </Label>
          {/* Why: no onSetDefault — picking a fork base must not change the project's default. */}
          <CreateFromPicker
            repoId={repoId}
            repoMap={repoMap}
            worktrees={worktrees}
            value={pickerValue(base, parentValue)}
            compact
            readOnly={disabled}
            ariaLabelledBy={labelId}
            onValueChange={(value) => onBaseChange(baseFromPicker(value, parentValue))}
          />
          <p className="text-[11px] text-muted-foreground">
            {startFromHelp(parentBranch, parentCommit, workspace)}
          </p>
          {base.kind === 'parent-commit' ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onBaseChange({ kind: 'parent-commit' })}
            >
              {translate(
                'components.agentSessionFork.useParentCommit',
                "Start from {{workspace}}'s commit",
                { workspace }
              )}
            </Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
