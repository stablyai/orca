import { useMemo, useState } from 'react'
import { StickyNote } from 'lucide-react'
import { useAppStore } from '@/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { QuickNote } from '../../../../shared/quick-note-types'
import { createQuickNoteDraft, QuickNoteDialog } from '@/components/quick-notes/QuickNoteDialog'
import { copyQuickNoteToClipboard } from '@/components/quick-notes/copy-quick-note'
import { TabBarQuickNotesMenu } from './TabBarQuickNotesMenu'

const EMPTY_NOTES: QuickNote[] = []

export function TabBarQuickNotesButton(): React.JSX.Element {
  const notes = useAppStore((s) => s.settings?.quickNotes ?? EMPTY_NOTES)
  const recentQuickNoteId = useAppStore((s) => s.recentQuickNoteId)
  const confirm = useConfirmationDialog()
  const [editor, setEditor] = useState<{ mode: 'add' | 'edit'; note: QuickNote } | null>(null)

  const mostRecent = useMemo(
    () => notes.find((note) => note.id === recentQuickNoteId) ?? notes[0] ?? null,
    [notes, recentQuickNoteId]
  )

  const openAdd = (): void => setEditor({ mode: 'add', note: createQuickNoteDraft() })

  const handleSave = (next: QuickNote): void => {
    void useAppStore.getState().upsertQuickNote(next)
  }

  const handleCopy = (note: QuickNote): void => {
    void copyQuickNoteToClipboard(note)
    useAppStore.getState().setRecentQuickNoteId(note.id)
  }

  const handleDelete = async (note: QuickNote): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'auto.components.tab.bar.TabBarQuickNotesButton.deleteTitle',
        'Delete "{{value0}}"?',
        { value0: note.label }
      ),
      description: translate(
        'auto.components.tab.bar.TabBarQuickNotesButton.deleteDescription',
        'This quick note will be removed from your saved list.'
      ),
      confirmLabel: translate('auto.components.tab.bar.TabBarQuickNotesButton.delete', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    void useAppStore.getState().deleteQuickNote(note.id)
  }

  const dialog = (
    <QuickNoteDialog
      open={editor !== null}
      mode={editor?.mode ?? 'add'}
      note={editor?.note ?? createQuickNoteDraft()}
      onOpenChange={(open) => !open && setEditor(null)}
      onSave={handleSave}
    />
  )

  if (notes.length === 0) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={openAdd}
              className="my-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={translate(
                'auto.components.tab.bar.TabBarQuickNotesButton.addAria',
                'Add quick note'
              )}
            >
              <StickyNote className="size-3.5" />
              <span className="text-[12px] font-medium">
                {translate('auto.components.tab.bar.TabBarQuickNotesButton.note', 'Note')}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.tab.bar.TabBarQuickNotesButton.addTooltip',
              'Save a reusable note you can copy to the clipboard'
            )}
          </TooltipContent>
        </Tooltip>
        {dialog}
      </>
    )
  }

  return (
    <>
      <TabBarQuickNotesMenu
        notes={notes}
        mostRecent={mostRecent}
        onCopyNote={handleCopy}
        onAddNote={openAdd}
        onEditNote={(note) => setEditor({ mode: 'edit', note })}
        onDeleteNote={(note) => void handleDelete(note)}
      />
      {dialog}
    </>
  )
}
