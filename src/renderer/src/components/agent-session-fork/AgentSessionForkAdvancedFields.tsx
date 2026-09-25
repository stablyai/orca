import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import type { AgentSessionForkBase } from '@/lib/agent-session-fork-flow'
import { useRepoMap, useWorktreesForRepo } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

function pickerValue(base: AgentSessionForkBase, parentBranch: string | null): string {
  if (base.kind === 'ref') {
    return base.ref
  }
  // Why: '' is the picker's "Project default" row; the parent commit shows as its branch.
  return base.kind === 'repo-default' ? '' : (parentBranch ?? '')
}

function baseFromPicker(value: string, parentBranch: string | null): AgentSessionForkBase {
  if (!value) {
    return { kind: 'repo-default' }
  }
  // Why: an attached worktree's branch tip is its HEAD, so picking it keeps the carry available.
  return value === parentBranch ? { kind: 'parent-commit' } : { kind: 'ref', ref: value }
}

// Why: same "Advanced" disclosure as the composer and add-host dialogs (ghost button + chevron).
export function AgentSessionForkAdvancedFields({
  open,
  onOpenChange,
  repoId,
  base,
  parentBranch,
  workspace,
  onBaseChange,
  disabled
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoId: string
  base: AgentSessionForkBase
  parentBranch: string | null
  workspace: string
  onBaseChange: (base: AgentSessionForkBase) => void
  disabled: boolean
}): React.JSX.Element {
  const repoMap = useRepoMap()
  const worktrees = useWorktreesForRepo(repoId)
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
          <Label>{translate('components.agentSessionFork.startFrom', 'Start from')}</Label>
          {/* Why: no onSetDefault — picking a fork base must not change the project's default. */}
          <CreateFromPicker
            repoId={repoId}
            repoMap={repoMap}
            worktrees={worktrees}
            value={pickerValue(base, parentBranch)}
            compact
            readOnly={disabled}
            onValueChange={(value) => onBaseChange(baseFromPicker(value, parentBranch))}
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'components.agentSessionFork.startFromHelp',
              'Default: the current commit of {{branch}}.',
              { branch: parentBranch ?? workspace }
            )}
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
