import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { recoveredEditorDraftId } from '@/store/slices/editor/buffers/recovered-editor-drafts'
import type { RecoveredEditorDraft } from '../../../../shared/workspace-session-state-types'
import { RecoveredEditorDraftCompareDialog } from './RecoveredEditorDraftCompareDialog'

const TOAST_ID = 'recovered-editor-drafts'

function draftLabel(draft: RecoveredEditorDraft): string {
  const path = draft.relativePath ?? draft.filePath
  const name = path.split(/[\\/]/).pop() || path
  const workspace =
    findWorktreeById(useAppStore.getState().worktreesByRepo ?? {}, draft.worktreeId)?.displayName ??
    draft.worktreeId
  return `${name} — ${workspace}`
}

/**
 * Offers back drafts an older session held in a second tab of a file. Each stays until dismissed;
 * closing the notice hides the drafts it showed, and a draft recovered later shows it again.
 */
export function RecoveredEditorDraftsNotice(): React.JSX.Element {
  const drafts = useAppStore((state) => state.recoveredEditorDrafts)
  const [comparing, setComparing] = useState<RecoveredEditorDraft | null>(null)
  const hiddenRef = useRef(new Set<string>())

  useEffect(() => {
    const shown = drafts.filter((draft) => !hiddenRef.current.has(recoveredEditorDraftId(draft)))
    if (shown.length === 0) {
      toast.dismiss(TOAST_ID)
      return
    }
    toast(
      translate(
        'auto.components.editor.RecoveredEditorDraftsNotice.3c7e0b5d18',
        'Recovered {{value0}} unsaved draft(s) from an earlier session',
        { value0: shown.length }
      ),
      {
        id: TOAST_ID,
        duration: Infinity,
        onDismiss: () => {
          for (const draft of shown) {
            hiddenRef.current.add(recoveredEditorDraftId(draft))
          }
        },
        description: (
          <div className="mt-1 flex flex-col gap-1">
            {shown.map((draft) => (
              <div key={recoveredEditorDraftId(draft)} className="flex flex-col">
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate">{draftLabel(draft)}</span>
                  <Button size="xs" variant="outline" onClick={() => setComparing(draft)}>
                    {translate(
                      'auto.components.editor.RecoveredEditorDraftsNotice.9a51e2f074',
                      'Compare'
                    )}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void window.api.ui.writeClipboardText(draft.draft)}
                  >
                    {translate(
                      'auto.components.editor.RecoveredEditorDraftsNotice.d40b6a2c95',
                      'Copy'
                    )}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => useAppStore.getState().dismissRecoveredEditorDraft(draft)}
                  >
                    {translate(
                      'auto.components.editor.RecoveredEditorDraftsNotice.71fc3e8b2a',
                      'Dismiss'
                    )}
                  </Button>
                </div>
                {draft.keptForThisLaunchOnly ? (
                  <span className="text-muted-foreground">
                    {translate(
                      'auto.components.editor.RecoveredEditorDraftsNotice.5e8c41a7d3',
                      'Too large to keep after restart — Copy or Compare now.'
                    )}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )
      }
    )
  }, [drafts])

  return (
    <RecoveredEditorDraftCompareDialog
      draft={comparing}
      onOpenChange={(open) => !open && setComparing(null)}
    />
  )
}
