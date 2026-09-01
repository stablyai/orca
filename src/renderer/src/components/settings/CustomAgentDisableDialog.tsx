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
import { setTuiAgentEnabledAtRevision } from '@/lib/agent-catalog-authoring'
import { translate } from '@/i18n/i18n'
import type { CustomTuiAgentId } from '../../../../shared/types'
import type { AgentReferenceSummary } from '../../../../shared/agent-reference-snapshot'
import { summarizeDisableReferences } from './custom-agent-disable-plan'

export type CustomAgentDisableDialogAgent = {
  id: CustomTuiAgentId
  label: string
}

export type CustomAgentDisableDialogProps = {
  open: boolean
  agent: CustomAgentDisableDialogAgent
  /** Reference summary + catalog revision captured when the disable was initiated;
   *  the confirm rechecks this revision and refreshes on conflict (plan §973). */
  initialSummary: AgentReferenceSummary[]
  initialRevision: number
  onOpenChange: (open: boolean) => void
  onDisabled: () => void
}

/** Reference-aware confirmation for disabling a custom agent that has saved
 *  references (plan §973). Names the count, explains attended stock fallback,
 *  unattended failure, and snapshot replay, and rechecks the catalog revision on
 *  confirm — a conflict refreshes the summary without applying. Reversible, so
 *  the affirmative button is not destructive-styled. */
export function CustomAgentDisableDialog({
  open,
  agent,
  initialSummary,
  initialRevision,
  onOpenChange,
  onDisabled
}: CustomAgentDisableDialogProps): React.JSX.Element {
  const [summary, setSummary] = useState<AgentReferenceSummary[]>(initialSummary)
  const [expectedRevision, setExpectedRevision] = useState(initialRevision)
  const [disabling, setDisabling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  // Reseed captured state each time the dialog opens for an agent.
  useEffect(() => {
    if (open) {
      setSummary(initialSummary)
      setExpectedRevision(initialRevision)
      setError(null)
      setConflict(false)
    }
  }, [open, agent.id, initialRevision, initialSummary])

  const references = summarizeDisableReferences(summary)

  const confirmDisable = async (): Promise<void> => {
    setDisabling(true)
    setError(null)
    setConflict(false)
    const result = await setTuiAgentEnabledAtRevision(agent.id, false, expectedRevision)
    if (result.ok) {
      setDisabling(false)
      onDisabled()
      onOpenChange(false)
      return
    }
    if (result.code === 'catalog_revision_conflict') {
      // The catalog moved under us; refresh the count and revision without
      // applying so the user re-confirms against the current state.
      const refreshed = await window.api.settings.agentCatalog
        .referenceSummary({ id: agent.id })
        .catch(() => null)
      if (refreshed) {
        setSummary(refreshed)
      }
      setExpectedRevision(result.snapshot?.revision ?? result.revision)
      setConflict(true)
      setDisabling(false)
      return
    }
    setError(
      translate(
        'auto.components.settings.CustomAgentDisableDialog.error',
        'Could not disable this agent. Reopen Settings and try again.'
      )
    )
    setDisabling(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>
            {translate(
              'auto.components.settings.CustomAgentDisableDialog.title',
              'Disable {{label}}?',
              { label: agent.label }
            )}
          </DialogTitle>
          <DialogDescription>
            {references.unreadable
              ? translate(
                  'auto.components.settings.CustomAgentDisableDialog.usedByAtLeast',
                  'Used by at least {{count}} saved items.',
                  { count: references.total }
                )
              : translate(
                  'auto.components.settings.CustomAgentDisableDialog.usedBy',
                  'Used by {{count}} saved items.',
                  { count: references.total }
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 scrollbar-sleek overflow-y-auto px-6 py-4">
          <ul className="list-outside list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
            <li>
              {translate(
                'auto.components.settings.CustomAgentDisableDialog.consequenceAttended',
                'New interactive launches use the stock base agent and show a notice.'
              )}
            </li>
            <li>
              {translate(
                'auto.components.settings.CustomAgentDisableDialog.consequenceUnattended',
                'Automations, background, and orchestration fail until reassigned.'
              )}
            </li>
            <li>
              {translate(
                'auto.components.settings.CustomAgentDisableDialog.consequenceResumes',
                'Session resumes still work.'
              )}
            </li>
            <li>
              {translate(
                'auto.components.settings.CustomAgentDisableDialog.consequenceReversible',
                'You can re-enable anytime.'
              )}
            </li>
          </ul>
          {conflict ? (
            <p className="text-sm text-amber-600 dark:text-amber-500">
              {translate(
                'auto.components.settings.CustomAgentDisableDialog.conflict',
                'These settings changed while this was open. The count above is refreshed — confirm again to disable.'
              )}
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.CustomAgentEditorDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            className="min-w-24"
            disabled={disabling}
            onClick={() => void confirmDisable()}
          >
            {translate(
              'auto.components.settings.CustomAgentDisableDialog.confirm',
              'Disable agent'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
