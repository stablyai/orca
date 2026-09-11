import { useState } from 'react'
import { Plus, Search } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { QuickNote } from '../../../../shared/quick-note-types'
import { useAppStore } from '../../store'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { createQuickNoteDraft, QuickNoteDialog } from '@/components/quick-notes/QuickNoteDialog'
import { searchQuickNotes } from '@/components/quick-notes/quick-note-search'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { QuickNotesList } from './QuickNotesList'

type QuickNotesPaneProps = {
  settings: GlobalSettings
}

export function QuickNotesPane({ settings }: QuickNotesPaneProps): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const notes = settings.quickNotes ?? []
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<{ mode: 'add' | 'edit'; note: QuickNote } | null>(null)

  const visibleNotes = searchQuickNotes(notes, query)
  const searchLabel = translate('auto.components.settings.QuickNotesPane.search', 'Search notes')

  const save = (next: QuickNote): void => {
    useAppStore.getState().recordFeatureInteraction('quick-notes')
    void useAppStore.getState().upsertQuickNote(next)
  }

  const remove = async (note: QuickNote): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'auto.components.settings.QuickNotesPane.deleteTitle',
        'Delete "{{value0}}"?',
        {
          value0: note.label || 'Untitled'
        }
      ),
      description: translate(
        'auto.components.settings.QuickNotesPane.deleteDescription',
        'This quick note will be removed from your saved list.'
      ),
      confirmLabel: translate('auto.components.settings.QuickNotesPane.delete', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    void useAppStore.getState().deleteQuickNote(note.id)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setEditor({ mode: 'add', note: createQuickNoteDraft() })}
        >
          <Plus />
          {translate('auto.components.settings.QuickNotesPane.add', 'Add Note')}
        </Button>
      </div>

      <QuickNotesList
        notes={notes}
        visibleNotes={visibleNotes}
        hasQuery={query.trim().length > 0}
        onEdit={(note) => setEditor({ mode: 'edit', note })}
        onRemove={(note) => void remove(note)}
      />

      {editor !== null ? (
        <QuickNoteDialog
          open
          mode={editor.mode}
          note={editor.note}
          onOpenChange={(open) => !open && setEditor(null)}
          onSave={save}
        />
      ) : null}
    </div>
  )
}
