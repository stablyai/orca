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
import { getAgentLabel } from '@/lib/agent-catalog'
import { deleteCustomTuiAgent } from '@/lib/agent-catalog-authoring'
import { translate } from '@/i18n/i18n'
import type { BuiltInTuiAgent, CustomTuiAgentId } from '../../../../shared/types'
import { CustomAgentDeleteDefaultChoice } from './CustomAgentDeleteDefaultChoice'
import {
  summarizeDeleteReferences,
  type DeleteDefaultChoice,
  type DeleteDefaultRecommendation
} from './custom-agent-delete-plan'
import { useAgentReferenceSummary } from './use-agent-reference-summary'

export type CustomAgentDeleteDialogAgent = {
  id: CustomTuiAgentId
  label: string
  baseAgent: BuiltInTuiAgent
  isDefault: boolean
}

export type CustomAgentDeleteDialogProps = {
  open: boolean
  agent: CustomAgentDeleteDialogAgent
  recommendation: DeleteDefaultRecommendation
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
  /** Opens the shared reference view. Absent until that dialog is wired; the
   *  count still renders so the confirmation is honest about existing references. */
  onReviewReferences?: () => void
}

/** Destructive confirmation for permanently deleting a custom agent (plan §995):
 *  states the non-recoverable loss and stock-fallback consequences, lists the
 *  reference count, and — when the agent is the current default — offers the
 *  four `delete-custom` onDefault outcomes with a launchability-aware default. */
export function CustomAgentDeleteDialog({
  open,
  agent,
  recommendation,
  onOpenChange,
  onDeleted,
  onReviewReferences
}: CustomAgentDeleteDialogProps): React.JSX.Element {
  const [choice, setChoice] = useState<DeleteDefaultChoice>(recommendation.recommended)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { summary } = useAgentReferenceSummary(agent.id, open)
  const baseLabel = getAgentLabel(agent.baseAgent)

  // Seed the pre-selected outcome from the launchability-aware recommendation
  // whenever the dialog (re)opens for a given agent.
  useEffect(() => {
    if (open) {
      setChoice(recommendation.recommended)
      setError(null)
    }
  }, [open, recommendation.recommended])

  const references = summarizeDeleteReferences(summary ?? [])
  const showReferenceLine = summary !== null && references.total > 0

  const confirmDelete = async (): Promise<void> => {
    setDeleting(true)
    setError(null)
    const result = await deleteCustomTuiAgent(agent.id, agent.isDefault ? choice : undefined)
    setDeleting(false)
    if (!result.ok) {
      setError(
        translate(
          'auto.components.settings.CustomAgentDeleteDialog.error',
          'Could not delete this agent. Reopen Settings and try again.'
        )
      )
      return
    }
    onDeleted()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>
            {translate(
              'auto.components.settings.CustomAgentDeleteDialog.title',
              'Delete {{label}}?',
              {
                label: agent.label
              }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.CustomAgentDeleteDialog.permanent',
              "This can't be undone. Custom launch settings are gone for good."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 scrollbar-sleek overflow-y-auto px-6 py-4">
          <ul className="list-outside list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
            <li>
              {translate(
                'auto.components.settings.CustomAgentDeleteDialog.consequenceRunning',
                'Open terminals keep running.'
              )}
            </li>
            <li>
              {translate(
                'auto.components.settings.CustomAgentDeleteDialog.consequenceAttended',
                'New interactive launches use stock {{base}} and show a notice.',
                { base: baseLabel }
              )}
            </li>
            <li>
              {translate(
                'auto.components.settings.CustomAgentDeleteDialog.consequenceUnattended',
                'Automations and background runs fail until reassigned.'
              )}
            </li>
            <li>
              {translate(
                'auto.components.settings.CustomAgentDeleteDialog.consequencePreserved',
                'Resumes, worktrees, history, and provider sessions stay.'
              )}
            </li>
          </ul>

          {showReferenceLine ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="text-sm">
                {references.unreadable
                  ? translate(
                      'auto.components.settings.CustomAgentDeleteDialog.usedByAtLeast',
                      'Used by at least {{count}} saved items',
                      { count: references.total }
                    )
                  : translate(
                      'auto.components.settings.CustomAgentDeleteDialog.usedBy',
                      'Used by {{count}} saved items',
                      { count: references.total }
                    )}
              </span>
              {onReviewReferences ? (
                <Button type="button" variant="outline" size="xs" onClick={onReviewReferences}>
                  {translate(
                    'auto.components.settings.CustomAgentDeleteDialog.reviewReferences',
                    'Review references'
                  )}
                </Button>
              ) : null}
            </div>
          ) : null}

          {agent.isDefault ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.CustomAgentDeleteDialog.defaultHeading',
                  'This agent is the current default'
                )}
              </p>
              <CustomAgentDeleteDefaultChoice
                baseLabel={baseLabel}
                value={choice}
                recommendation={recommendation}
                onChange={setChoice}
              />
              {!recommendation.detectionKnown ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.CustomAgentDeleteDialog.availabilityNote',
                    "Availability is checked at launch, so a rebind isn't guaranteed to be installed."
                  )}
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.CustomAgentEditorDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-w-24"
            disabled={deleting}
            onClick={() => void confirmDelete()}
          >
            {translate('auto.components.settings.CustomAgentDeleteDialog.confirm', 'Delete agent')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
