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
import type { BuiltInTuiAgent } from '../../../../shared/types'
import type { BaseDisableImpact } from '../../../../shared/agent-reference-snapshot'
import { countEnabledDerivatives } from './base-disable-plan'

export type BuiltInDisableDialogProps = {
  open: boolean
  base: BuiltInTuiAgent
  baseLabel: string
  /** Impact + revision captured when the disable was initiated; the confirm
   *  rechecks the revision and refreshes on conflict (plan §973). */
  initialEnabledDerivatives: number
  initialImpact: BaseDisableImpact
  initialRevision: number
  onOpenChange: (open: boolean) => void
  onDisabled: () => void
}

/** Reference-aware confirmation for disabling a built-in base harness (plan §973).
 *  Names the affected enabled derivatives, saved references, and resumable
 *  sessions, and states that every derivative/new launch and snapshot resume will
 *  block. Rechecks the catalog revision on confirm — a conflict refreshes the
 *  counts without applying. Reversible, so the button is not destructive-styled. */
export function BuiltInDisableDialog({
  open,
  base,
  baseLabel,
  initialEnabledDerivatives,
  initialImpact,
  initialRevision,
  onOpenChange,
  onDisabled
}: BuiltInDisableDialogProps): React.JSX.Element {
  const [enabledDerivatives, setEnabledDerivatives] = useState(initialEnabledDerivatives)
  const [impact, setImpact] = useState<BaseDisableImpact>(initialImpact)
  const [expectedRevision, setExpectedRevision] = useState(initialRevision)
  const [disabling, setDisabling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    if (open) {
      setEnabledDerivatives(initialEnabledDerivatives)
      setImpact(initialImpact)
      setExpectedRevision(initialRevision)
      setError(null)
      setConflict(false)
    }
  }, [open, base, initialRevision, initialImpact, initialEnabledDerivatives])

  const confirmDisable = async (): Promise<void> => {
    setDisabling(true)
    setError(null)
    setConflict(false)
    const result = await setTuiAgentEnabledAtRevision(base, false, expectedRevision)
    if (result.ok) {
      setDisabling(false)
      onDisabled()
      onOpenChange(false)
      return
    }
    if (result.code === 'catalog_revision_conflict') {
      const snapshot =
        result.snapshot ?? (await window.api.settings.agentCatalog.getLocal().catch(() => null))
      const refreshedImpact = await window.api.settings.agentCatalog
        .baseDisableImpact({ base })
        .catch(() => null)
      if (snapshot) {
        setEnabledDerivatives(countEnabledDerivatives(snapshot, base))
      }
      if (refreshedImpact) {
        setImpact(refreshedImpact)
      }
      setExpectedRevision(result.snapshot?.revision ?? result.revision)
      setConflict(true)
      setDisabling(false)
      return
    }
    setError(
      translate(
        'auto.components.settings.BuiltInDisableDialog.error',
        'Could not disable this harness. Reopen Settings and try again.'
      )
    )
    setDisabling(false)
  }

  const countRows: string[] = []
  if (enabledDerivatives > 0) {
    countRows.push(
      translate(
        'auto.components.settings.BuiltInDisableDialog.derivatives',
        '{{count}} enabled custom agents built on it',
        { count: enabledDerivatives }
      )
    )
  }
  if (impact.savedReferences.count > 0 || impact.savedReferences.atLeast) {
    countRows.push(
      impact.savedReferences.atLeast
        ? translate(
            'auto.components.settings.BuiltInDisableDialog.referencesAtLeast',
            'Used by at least {{count}} saved items (including its custom agents)',
            { count: impact.savedReferences.count }
          )
        : translate(
            'auto.components.settings.BuiltInDisableDialog.references',
            'Used by {{count}} saved items (including its custom agents)',
            { count: impact.savedReferences.count }
          )
    )
  }
  if (impact.resumableSessions.count > 0 || impact.resumableSessions.atLeast) {
    countRows.push(
      impact.resumableSessions.atLeast
        ? translate(
            'auto.components.settings.BuiltInDisableDialog.sessionsAtLeast',
            'At least {{count}} resumable sessions',
            { count: impact.resumableSessions.count }
          )
        : translate(
            'auto.components.settings.BuiltInDisableDialog.sessions',
            '{{count}} resumable sessions',
            { count: impact.resumableSessions.count }
          )
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>
            {translate('auto.components.settings.BuiltInDisableDialog.title', 'Disable {{base}}?', {
              base: baseLabel
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.BuiltInDisableDialog.consequences',
              'Every new launch on {{base}} — including its custom agents — will block until you re-enable it, and snapshot resumes on it will block too.',
              { base: baseLabel }
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 scrollbar-sleek overflow-y-auto px-6 py-4">
          {countRows.length > 0 ? (
            <ul className="space-y-1">
              {countRows.map((row) => (
                <li
                  key={row}
                  className="rounded-md border border-border bg-muted/20 px-3 py-1.5 text-sm"
                >
                  {row}
                </li>
              ))}
            </ul>
          ) : null}
          {conflict ? (
            <p className="text-sm text-amber-600 dark:text-amber-500">
              {translate(
                'auto.components.settings.BuiltInDisableDialog.conflict',
                'These settings changed while this was open. The counts above are refreshed — confirm again to disable.'
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
            {translate('auto.components.settings.BuiltInDisableDialog.confirm', 'Disable agent')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
