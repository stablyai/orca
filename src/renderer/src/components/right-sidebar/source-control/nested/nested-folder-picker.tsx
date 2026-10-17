import React from 'react'
import { ChevronDown, FolderOpen, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { displayPathInsideWorktree } from './nested-folder-paths'
import type { NestedFolderScope } from './use-nested-folder-scope'

export function NestedFolderPicker({
  worktreePath,
  scope
}: {
  worktreePath: string
  scope: NestedFolderScope
}): React.JSX.Element {
  const folderLabel = scope.folderPath
    ? displayPathInsideWorktree(worktreePath, scope.folderPath)
    : translate('sourceControl.nestedFolder.workspaceRoot', 'This workspace')

  const [folders, setFolders] = React.useState<string[]>([])
  const [loadingFolders, setLoadingFolders] = React.useState(false)

  const loadFolders = (open: boolean): void => {
    if (open) {
      setLoadingFolders(true)
      void scope
        .listRepoFolders()
        .then(setFolders)
        .catch(() => setFolders([]))
        .finally(() => setLoadingFolders(false))
    }
  }

  const browseFolder = async (): Promise<void> => {
    const picked = await window.api.shell.pickDirectory({
      defaultPath: scope.folderPath ?? worktreePath
    })
    if (picked) {
      scope.setFolderPath(picked)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1 px-3 pb-1 pt-0.5">
      <DropdownMenu onOpenChange={loadFolders}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="min-w-0 flex-1 justify-start"
            title={translate(
              'sourceControl.nestedFolder.pickTitle',
              'Show git repos inside a folder'
            )}
          >
            <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{folderLabel}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {loadingFolders && folders.length === 0 ? (
            <DropdownMenuItem disabled>
              {translate('sourceControl.nestedFolder.scanning', 'Looking for git repos…')}
            </DropdownMenuItem>
          ) : null}
          {folders.map((dir) => (
            <DropdownMenuItem key={dir} onSelect={() => scope.setFolderPath(dir)}>
              {displayPathInsideWorktree(worktreePath, dir)}
            </DropdownMenuItem>
          ))}
          {folders.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => void browseFolder()}>
            {translate('sourceControl.nestedFolder.browse', 'Browse…')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {scope.folderPath ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={translate('sourceControl.nestedFolder.clear', 'Clear folder')}
          title={translate('sourceControl.nestedFolder.clear', 'Clear folder')}
          onClick={() => scope.setFolderPath(null)}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
