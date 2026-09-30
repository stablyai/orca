import { useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  Pencil,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Textarea } from '@/components/ui/textarea'
import { PerforceShelvedFileRow } from './perforce-shelved-file-row'
import type {
  PerforceChangelist,
  PerforceShelvedFile
} from '../../../../../shared/perforce/perforce-types'

export type ChangelistActions = {
  busy: boolean
  onEditDescription: (description: string) => Promise<boolean>
  onGenerateDescription: () => Promise<string | null>
  onShelve: () => void
  onUnshelve: () => void
  onDeleteShelf: () => void
  onUnshelveFile: (file: PerforceShelvedFile) => void
  onDeleteWithFiles: () => void
  onCopyNumber: () => void
  onDiffShelved: (file: PerforceShelvedFile) => void
  onOpenShelved: (file: PerforceShelvedFile) => void
  onSubmit: () => void
  onDelete: () => void
}

/** Header for a numbered pending changelist: description (editable in place), shelf, and submit actions. */
export function PerforceChangelistHeader({
  changelist,
  fileCount,
  collapsed,
  aiEnabled,
  onToggle,
  actions
}: {
  changelist: PerforceChangelist
  fileCount: number
  collapsed: boolean
  aiEnabled: boolean
  onToggle: () => void
  actions: ChangelistActions
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(changelist.description)
  const shelved = changelist.shelvedFiles.length
  const { busy } = actions

  const save = async (): Promise<void> => {
    if (await actions.onEditDescription(draft)) {
      setEditing(false)
    }
  }

  return (
    <div className="px-2 pt-2 pb-1">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 text-left text-[13px]"
              aria-expanded={!collapsed}
              onClick={onToggle}
              title={changelist.description}
            >
              {collapsed ? (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="shrink-0 font-semibold">{changelist.id}</span>
              <span className="truncate text-muted-foreground">
                {changelist.description.split('\n')[0]}
              </span>
            </button>
            {collapsed ? (
              <span className="text-[11px] text-muted-foreground">{fileCount}</span>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Edit description"
                  disabled={busy}
                  onClick={() => {
                    setDraft(changelist.description)
                    setEditing(true)
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Shelve files"
                  disabled={busy || fileCount === 0}
                  onClick={actions.onShelve}
                >
                  <Archive />
                </Button>
                {shelved > 0 ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Unshelve files"
                      disabled={busy}
                      onClick={actions.onUnshelve}
                    >
                      <ArchiveRestore />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Revert shelved files"
                      disabled={busy}
                      onClick={actions.onDeleteShelf}
                    >
                      <Undo2 />
                    </Button>
                  </>
                ) : null}
                {fileCount === 0 && shelved === 0 ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Delete empty changelist"
                    disabled={busy}
                    onClick={actions.onDelete}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={
                    fileCount > 0 && shelved > 0
                      ? 'Revert the shelved files first: Perforce cannot submit a changelist with both opened and shelved files'
                      : shelved > 0
                        ? 'Submit the shelved files'
                        : 'Submit change'
                  }
                  disabled={
                    busy || (fileCount === 0 && shelved === 0) || (fileCount > 0 && shelved > 0)
                  }
                  onClick={actions.onSubmit}
                >
                  <Send />
                </Button>
                <span className="text-[11px] text-muted-foreground">{fileCount}</span>
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={actions.onCopyNumber}>Copy changelist number</ContextMenuItem>
          <ContextMenuItem disabled={busy} onSelect={actions.onDeleteWithFiles}>
            Delete changelist
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {collapsed ? null : (
        <>
          {editing ? (
            <div className="mt-1 flex flex-col gap-1">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                className="min-h-0"
              />
              <div className="flex justify-end gap-1">
                {aiEnabled ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy || fileCount === 0}
                    onClick={() =>
                      void actions.onGenerateDescription().then((t) => t && setDraft(t))
                    }
                  >
                    <Sparkles /> Generate
                  </Button>
                ) : null}
                <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
                  <X /> Cancel
                </Button>
                <Button
                  size="xs"
                  disabled={busy || draft.trim().length === 0}
                  onClick={() => void save()}
                >
                  <Check /> Save
                </Button>
              </div>
            </div>
          ) : null}
          <div className="mt-1 text-xs text-muted-foreground">
            <div>
              Shelved: {shelved} · Opened: {fileCount}
            </div>
            {shelved > 0 ? (
              <div className="-mx-2 mt-0.5 max-h-32 overflow-y-auto scrollbar-sleek text-foreground">
                {changelist.shelvedFiles.map((file) => (
                  <PerforceShelvedFileRow
                    key={file.depotPath}
                    file={file}
                    onDiff={() => actions.onDiffShelved(file)}
                    onOpen={() => actions.onOpenShelved(file)}
                    onUnshelve={() => actions.onUnshelveFile(file)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
