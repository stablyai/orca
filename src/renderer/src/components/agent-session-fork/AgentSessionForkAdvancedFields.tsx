import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import { useRepoMap, useWorktreesForRepo } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

// Why: same "Advanced" disclosure as the composer and add-host dialogs (ghost button + chevron).
export function AgentSessionForkAdvancedFields({
  open,
  onOpenChange,
  repoId,
  baseBranch,
  parentBranch,
  onBaseBranchChange,
  disabled
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoId: string
  baseBranch: string | null
  parentBranch: string | null
  onBaseBranchChange: (baseBranch: string | null) => void
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
            value={baseBranch ?? parentBranch ?? ''}
            compact
            readOnly={disabled}
            onValueChange={(value) =>
              // Why: the parent's own branch (or the project default) means "the parent's commit".
              onBaseBranchChange(value && value !== parentBranch ? value : null)
            }
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'components.agentSessionFork.startFromHelp',
              'Default: the current commit of {{branch}}.',
              { branch: parentBranch ?? '' }
            )}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
