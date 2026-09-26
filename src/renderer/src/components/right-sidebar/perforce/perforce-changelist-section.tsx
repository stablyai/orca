import { useState } from 'react'
import { Archive, ArchiveRestore, Check, Pencil, Send, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { PerforceChangelist } from '../../../../../shared/perforce/perforce-types'

type ChangelistActions = {
  busy: boolean
  onEditDescription: (description: string) => Promise<boolean>
  onShelve: () => void
  onUnshelve: () => void
  onDeleteShelf: () => void
  onSubmit: () => void
  onDelete: () => void
}

/** Header for a numbered pending changelist: description (editable in place), shelf, and submit actions. */
export function PerforceChangelistHeader({
  changelist,
  fileCount,
  actions
}: {
  changelist: PerforceChangelist
  fileCount: number
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
    <div className="px-2 pt-3 pb-1">
      <div className="flex items-center gap-1">
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground"
          title={changelist.description}
        >
          {`Changelist ${changelist.id}`}
        </span>
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
              title="Delete shelf"
              disabled={busy}
              onClick={actions.onDeleteShelf}
            >
              <Trash2 />
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
            shelved > 0
              ? 'Delete the shelf first: Perforce cannot submit a changelist that has shelved files'
              : 'Submit change'
          }
          disabled={busy || fileCount === 0 || shelved > 0}
          onClick={actions.onSubmit}
        >
          <Send />
        </Button>
        <span className="text-[11px] text-muted-foreground">{fileCount}</span>
      </div>
      {editing ? (
        <div className="mt-1 flex flex-col gap-1">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            className="min-h-0"
          />
          <div className="flex justify-end gap-1">
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
      ) : (
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {changelist.description}
        </div>
      )}
      {shelved > 0 ? (
        <div className="mt-1 text-xs text-muted-foreground">
          <div>
            Shelved: {shelved} file{shelved === 1 ? '' : 's'}
          </div>
          <ul className="mt-0.5 max-h-24 overflow-y-auto scrollbar-sleek font-mono text-[11px]">
            {changelist.shelvedFiles.map((file) => (
              <li key={file.depotPath} className="truncate" title={file.depotPath}>
                {file.depotPath}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
