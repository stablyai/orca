import { File, Folder, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import type { EditorHeaderDirectoryListing } from './editor-header-path-directory'
import { isEditorHeaderPathCurrentEntry } from './editor-header-path-segments'

type EditorHeaderPathDirectoryMenuProps = {
  loadState: EditorHeaderDirectoryListing | { status: 'loading' }
  directoryAbsolutePath: string
  currentFilePath: string
  onSelectEntry: (entry: DirEntry) => void
}

export function EditorHeaderPathDirectoryMenu({
  loadState,
  directoryAbsolutePath,
  currentFilePath,
  onSelectEntry
}: EditorHeaderPathDirectoryMenuProps): React.JSX.Element {
  if (loadState.status === 'loading') {
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {translate('auto.components.editor.EditorPanelHeaderPath.3c8f0d21a6', 'Loading…')}
      </div>
    )
  }

  if (loadState.status === 'error') {
    return (
      <div className="max-w-[18rem] px-2 py-2 text-xs text-destructive" role="alert">
        {loadState.message}
      </div>
    )
  }

  if (loadState.entries.length === 0) {
    return (
      <div className="px-2 py-2 text-xs text-muted-foreground">
        {translate(
          'auto.components.editor.EditorPanelHeaderPath.9b14e6c2d0',
          'This folder is empty.'
        )}
      </div>
    )
  }

  return (
    <div className="popover-scroll-content scrollbar-sleek max-h-72 min-w-[12rem] overflow-y-auto p-1">
      {loadState.entries.map((entry) => {
        const isCurrent =
          !entry.isDirectory &&
          isEditorHeaderPathCurrentEntry(directoryAbsolutePath, entry.name, currentFilePath)
        return (
          <button
            key={`${entry.isDirectory ? 'dir' : 'file'}:${entry.name}`}
            type="button"
            data-current={isCurrent ? 'true' : undefined}
            data-editor-header-path-entry={entry.name}
            data-editor-header-path-entry-kind={entry.isDirectory ? 'directory' : 'file'}
            className={cn(
              'flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left text-[12px] leading-5 font-medium text-foreground hover:bg-accent',
              isCurrent && 'bg-accent'
            )}
            onClick={() => onSelectEntry(entry)}
          >
            {entry.isDirectory ? (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <File className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
        )
      })}
    </div>
  )
}
