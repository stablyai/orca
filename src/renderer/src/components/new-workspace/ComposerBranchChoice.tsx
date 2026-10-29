import { useId, useRef } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type Props = {
  existingBranchName?: string | null
  reuseSelectedBranch: boolean
  onReuseSelectedBranchChange: (next: boolean) => void
  branchNameOverride: string | undefined
  onBranchNameOverrideChange: (value: string | undefined) => void
  onOpenSelectedBranchWorkspace?: () => void
  disabled: boolean
}

export function ComposerBranchChoice({
  existingBranchName,
  reuseSelectedBranch,
  onReuseSelectedBranchChange,
  branchNameOverride,
  onBranchNameOverrideChange,
  onOpenSelectedBranchWorkspace,
  disabled
}: Props) {
  const id = useId()
  const branchNameInputRef = useRef<HTMLInputElement>(null)
  const showOpenWorkspace = reuseSelectedBranch && Boolean(onOpenSelectedBranchWorkspace)
  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="text-xs font-medium text-muted-foreground">
        {translate('workspace.branchChoice.title', 'Branch for this worktree')}
      </legend>
      <RadioGroup
        aria-label={translate('workspace.branchChoice.title', 'Branch for this worktree')}
        value={reuseSelectedBranch ? 'existing' : 'new'}
        onValueChange={(value) => onReuseSelectedBranchChange(value === 'existing')}
        disabled={disabled}
      >
        <div
          className={cn(
            'min-w-0 rounded-md border border-border',
            reuseSelectedBranch && 'bg-accent/50 text-accent-foreground'
          )}
        >
          <label className="flex cursor-pointer items-start gap-2 p-3">
            <RadioGroupItem
              value="existing"
              className="mt-0.5"
              aria-labelledby={`${id}-existing`}
              aria-describedby={
                existingBranchName
                  ? `${id}-existing-name ${id}-existing-description`
                  : `${id}-existing-description`
              }
            />
            <span className="min-w-0 space-y-1">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span id={`${id}-existing`} className="shrink-0 text-xs font-medium">
                  {translate('workspace.branchChoice.existing', 'Existing branch')}
                </span>
                {existingBranchName ? (
                  <span
                    id={`${id}-existing-name`}
                    className="min-w-0 max-w-full break-all font-mono text-xs"
                  >
                    {existingBranchName}
                  </span>
                ) : null}
              </span>
              <span
                id={`${id}-existing-description`}
                className="block text-xs text-muted-foreground"
              >
                {translate('workspace.branchChoice.existingHint', 'New commits go on this branch.')}
              </span>
            </span>
          </label>
          {showOpenWorkspace ? (
            <div className="px-3 pb-3 pl-9">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onOpenSelectedBranchWorkspace}
              >
                {translate(
                  'auto.components.NewWorkspaceComposerCard.openExistingWorkspace',
                  'Open existing workspace'
                )}
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>
        <div
          className={cn(
            'min-w-0 rounded-md border border-border',
            !reuseSelectedBranch && 'bg-accent/50 text-accent-foreground'
          )}
        >
          <label className="flex cursor-pointer items-start gap-2 p-3">
            <RadioGroupItem
              value="new"
              onClick={() => branchNameInputRef.current?.focus()}
              className="mt-0.5"
              aria-labelledby={`${id}-new`}
              aria-describedby={`${id}-new-description`}
            />
            <span className="min-w-0 space-y-1">
              <span id={`${id}-new`} className="block text-xs font-medium">
                {translate('workspace.branchChoice.new', 'New branch')}
              </span>
              <span id={`${id}-new-description`} className="block text-xs text-muted-foreground">
                {translate('workspace.branchChoice.newHint', 'Create a new local branch')}
              </span>
            </span>
          </label>
          {!reuseSelectedBranch ? (
            <div className="space-y-1 px-3 pb-3 pl-9">
              <label htmlFor={`${id}-name`} className="text-xs font-medium">
                {translate('workspace.branchChoice.newName', 'New branch name')}
              </label>
              <Input
                id={`${id}-name`}
                ref={branchNameInputRef}
                variant="code"
                surface="background"
                autoFocus
                value={branchNameOverride ?? ''}
                onChange={(event) => onBranchNameOverrideChange(event.target.value)}
                placeholder={translate('workspace.branchChoice.automaticName', 'Automatic name')}
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
          ) : null}
        </div>
      </RadioGroup>
    </fieldset>
  )
}
