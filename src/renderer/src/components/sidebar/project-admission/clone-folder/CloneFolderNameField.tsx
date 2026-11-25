import React from 'react'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import type { CloneFolderOverride } from './use-clone-folder-override'

export function CloneFolderNameField({
  cloneFolder,
  disabled,
  onChange,
  onKeyDown
}: {
  cloneFolder: CloneFolderOverride
  disabled: boolean
  onChange: (name: string) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">
        {t('auto.components.sidebar.AddRepoSteps.cloneFolderName', 'Folder name')}
      </label>
      <Input
        value={cloneFolder.name}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        disabled={disabled}
        autoFocus
      />
      <p className="text-[11px] text-muted-foreground">
        {cloneFolder.taken.reason === 'other-repository'
          ? t(
              'auto.components.sidebar.AddRepoSteps.cloneFolderTakenByRepo',
              '"{{value0}}" in this folder is already a different repository, so this clone needs its own folder.',
              { value0: cloneFolder.taken.folderName }
            )
          : t(
              'auto.components.sidebar.AddRepoSteps.cloneFolderNotEmpty',
              '"{{value0}}" already exists in this folder, so this clone needs its own folder.',
              { value0: cloneFolder.taken.folderName }
            )}
      </p>
    </div>
  )
}
