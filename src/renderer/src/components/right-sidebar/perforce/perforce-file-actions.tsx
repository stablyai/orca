import { Plus, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PerforceEntry } from '../../../../../shared/perforce/perforce-types'

/** Hover actions on a file row: open (add or edit) and revert. */
export function PerforceFileActions({
  entry,
  busy,
  onOpen,
  onDiscard
}: {
  entry: PerforceEntry
  busy: boolean
  onOpen: () => void
  onDiscard: () => void
}) {
  return (
    <>
      {entry.group === 'opened' ? null : (
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
        title="Revert changes"
        disabled={busy}
        onClick={onDiscard}
      >
        <Undo2 />
      </Button>
    </>
  )
}
