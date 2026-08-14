import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

export type WorktreeVisibilitySourceAddResult =
  | 'added'
  | 'invalid-path'
  | 'duplicate-path'
  | 'limit'
  | 'save-failed'

export function WorktreeVisibilitySourceAddForm({
  disabled,
  onAdd
}: {
  disabled: boolean
  onAdd: (rootPath: string) => Promise<WorktreeVisibilitySourceAddResult>
}): React.JSX.Element {
  const [rootPath, setRootPath] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault()
    setInputError(null)
    const result = await onAdd(rootPath)
    if (result === 'added') {
      setRootPath('')
      return
    }
    if (result === 'save-failed') {
      return
    }
    setInputError(
      result === 'limit'
        ? translate(
            'auto.components.sidebar.WorktreeVisibilitySourceList.limit',
            'Remove a custom location before adding another.'
          )
        : result === 'duplicate-path'
          ? translate(
              'auto.components.sidebar.WorktreeVisibilitySourceList.duplicatePath',
              'This location is already listed.'
            )
          : translate(
              'auto.components.sidebar.WorktreeVisibilitySourceList.invalidPath',
              'Enter an absolute path for this host.'
            )
    )
  }

  return (
    <form
      className="grid gap-2 border-t border-border bg-background/50 px-2.5 py-2.5"
      aria-label={translate(
        'auto.components.sidebar.WorktreeVisibilitySourceList.addLocation',
        'Add location'
      )}
      onSubmit={(event) => void handleAdd(event)}
    >
      <Label htmlFor="custom-worktree-root" className="text-[13px]">
        {translate(
          'auto.components.sidebar.WorktreeVisibilitySourceList.worktreeRoot',
          'Worktree root'
        )}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="custom-worktree-root"
          className="font-mono text-xs"
          value={rootPath}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={inputError ? true : undefined}
          aria-describedby="custom-worktree-root-help"
          onChange={(event) => {
            setRootPath(event.target.value)
            setInputError(null)
          }}
        />
        <Button type="submit" size="sm" disabled={disabled || !rootPath.trim()}>
          {translate('auto.components.sidebar.WorktreeVisibilitySourceList.add', 'Add')}
        </Button>
      </div>
      <p
        id="custom-worktree-root-help"
        className={`text-[11px] ${inputError ? 'text-destructive' : 'text-muted-foreground'}`}
        role={inputError ? 'alert' : undefined}
      >
        {inputError ??
          translate(
            'auto.components.sidebar.WorktreeVisibilitySourceList.rootHelp',
            'Orca will recognize worktrees beneath this folder.'
          )}
      </p>
    </form>
  )
}
