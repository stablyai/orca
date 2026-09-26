import { Plus, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PerforceEntry } from '../../../../../shared/perforce/perforce-types'

/** Hover actions on a file row: close/open (add or edit) and discard. */
export function PerforceFileActions({
  entry,
  busy,
  onClose,
  onOpen,
  onDiscard
}: {
  entry: PerforceEntry
  busy: boolean
  onClose: () => void
  onOpen: () => void
  onDiscard: () => void
}) {
  return (
    <>
      {entry.group === 'opened' ? (
        <Button
          variant="ghost"
          size="icon-xs"
          title="Close file (keep local changes)"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          title={entry.group === 'new' ? 'Mark for add' : 'Open for edit'}
          disabled={busy}
          onClick={onOpen}
        >
          <Plus />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        title="Discard changes"
        disabled={busy}
        onClick={onDiscard}
      >
        <Undo2 />
      </Button>
    </>
  )
}
