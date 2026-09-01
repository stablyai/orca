import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { AgentIcon } from '@/lib/agent-catalog'
import { mutateAgentCatalog } from '@/lib/agent-catalog-authoring'
import { translate } from '@/i18n/i18n'
import type { CustomTuiAgentId } from '../../../../shared/types'
import {
  assembleDuplicateRepairMutation,
  countKeepChoices,
  isDuplicateSelectionComplete,
  type DuplicateRepairChoice,
  type DuplicateRepairDraftResult,
  type DuplicateRepairRow,
  type DuplicateRepairSelection
} from './custom-agent-duplicate-repair-plan'

export type CustomAgentDuplicateRepairDialogProps = {
  open: boolean
  duplicateId: CustomTuiAgentId
  rows: readonly DuplicateRepairRow[]
  onOpenChange: (open: boolean) => void
  onResolved: () => void
}

async function fetchRepairDraft(repairToken: string): Promise<DuplicateRepairDraftResult> {
  const snapshot = await window.api.settings.agentCatalog.getLocal()
  const result = await window.api.settings.agentCatalog.getLocalDraft({
    locator: { repairToken },
    expectedRevision: snapshot.revision
  })
  if (result.status === 'stale') {
    return 'stale'
  }
  if (result.status === 'too-large') {
    return 'too-large'
  }
  return result.draft
}

/** Grouped, atomic repair for a set of custom rows that share one live id
 *  (plan §850). Every row picks keep / replace / discard; at most one keeps the
 *  id for existing references, and the whole decision commits in one mutation. */
export function CustomAgentDuplicateRepairDialog({
  open,
  duplicateId,
  rows,
  onOpenChange,
  onResolved
}: CustomAgentDuplicateRepairDialogProps): React.JSX.Element {
  const [selection, setSelection] = useState<DuplicateRepairSelection>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setSelection({})
      setError(null)
    }
  }, [open])

  const choose = (repairToken: string, choice: DuplicateRepairChoice): void => {
    setSelection((current) => {
      const next: DuplicateRepairSelection = { ...current, [repairToken]: choice }
      // Only one row may keep the shared id; force any prior keep to be re-decided.
      if (choice === 'keep') {
        for (const token of Object.keys(next)) {
          if (token !== repairToken && next[token] === 'keep') {
            delete next[token]
          }
        }
      }
      return next
    })
    setError(null)
  }

  const complete = isDuplicateSelectionComplete(rows, selection) && countKeepChoices(selection) <= 1

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    const assembled = await assembleDuplicateRepairMutation({
      duplicateId,
      rows,
      selection,
      fetchDraft: fetchRepairDraft
    })
    if (!assembled.ok) {
      setSubmitting(false)
      setError(duplicateAssemblyError(assembled.reason))
      return
    }
    const result = await mutateAgentCatalog(assembled.mutation)
    setSubmitting(false)
    if (!result.ok) {
      setError(
        translate(
          'auto.components.settings.CustomAgentDuplicateRepairDialog.mutationError',
          'Could not resolve these agents. Reopen Settings and try again.'
        )
      )
      return
    }
    onResolved()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>
            {translate(
              'auto.components.settings.CustomAgentDuplicateRepairDialog.title',
              'Resolve duplicate agents'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.CustomAgentDuplicateRepairDialog.description',
              'These agents share one saved identity. Choose one to keep for existing references, and replace or discard the rest. This is applied all at once.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 scrollbar-sleek overflow-y-auto px-6 py-4">
          {rows.map((row) => (
            <DuplicateRow
              key={row.repairToken}
              row={row}
              choice={selection[row.repairToken]}
              onChoose={(choice) => choose(row.repairToken, choice)}
            />
          ))}
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CustomAgentDuplicateRepairDialog.referencesNote',
              'Replaced agents get a new identity; discarded agents are removed. Saved references only keep working for the agent you keep.'
            )}
          </p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.CustomAgentEditorDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            className="min-w-24"
            disabled={submitting || !complete}
            onClick={() => void submit()}
          >
            {translate(
              'auto.components.settings.CustomAgentDuplicateRepairDialog.confirm',
              'Resolve agents'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DuplicateRow({
  row,
  choice,
  onChoose
}: {
  row: DuplicateRepairRow
  choice: DuplicateRepairChoice | undefined
  onChoose: (choice: DuplicateRepairChoice) => void
}): React.JSX.Element {
  const label =
    row.label ??
    translate(
      'auto.components.settings.CustomAgentDuplicateRepairDialog.fallbackLabel',
      'Custom agent'
    )
  // Keep and replace both need the row's draft; only discard works when too large.
  const draftUnavailable = row.draftAvailability !== 'available'
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <AgentIcon agent={row.baseAgent} size={16} />
        <span className="truncate text-sm font-medium">{label}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <ChoiceButton
          active={choice === 'keep'}
          disabled={draftUnavailable}
          onClick={() => onChoose('keep')}
          label={translate(
            'auto.components.settings.CustomAgentDuplicateRepairDialog.keep',
            'Keep for existing references'
          )}
        />
        <ChoiceButton
          active={choice === 'replace'}
          disabled={draftUnavailable}
          onClick={() => onChoose('replace')}
          label={translate(
            'auto.components.settings.CustomAgentDuplicateRepairDialog.replace',
            'Replace as new'
          )}
        />
        <ChoiceButton
          active={choice === 'discard'}
          onClick={() => onChoose('discard')}
          label={translate(
            'auto.components.settings.CustomAgentDuplicateRepairDialog.discard',
            'Discard'
          )}
        />
      </div>
      {draftUnavailable ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CustomAgentDuplicateRepairDialog.tooLargeNote',
            'This row is too large to keep or replace here. Discard it, or reduce it on the desktop host.'
          )}
        </p>
      ) : null}
    </div>
  )
}

function ChoiceButton({
  active,
  disabled,
  onClick,
  label
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="xs"
      variant={active ? 'default' : 'outline'}
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </Button>
  )
}

function duplicateAssemblyError(
  reason: 'incomplete' | 'multiple-keep' | 'draft-unavailable'
): string {
  if (reason === 'draft-unavailable') {
    return translate(
      'auto.components.settings.CustomAgentDuplicateRepairDialog.draftUnavailableError',
      'One of these agents is too large to keep or replace here. Discard it, or reduce it on the desktop host.'
    )
  }
  return translate(
    'auto.components.settings.CustomAgentDuplicateRepairDialog.incompleteError',
    'Choose an action for every agent, keeping at most one.'
  )
}
