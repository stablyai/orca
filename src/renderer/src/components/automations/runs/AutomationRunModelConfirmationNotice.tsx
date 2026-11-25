// The line that replaces the failure banner once a picked model is saved.
import React, { useCallback } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { AutomationRunModelConfirmation } from './automation-run-model-fix'

export function AutomationRunModelConfirmationNotice({
  confirmation
}: {
  confirmation: AutomationRunModelConfirmation
}): React.JSX.Element {
  const t = useTranslate()
  // Why: saving unmounts the picker that had focus, dropping it to the page. Land it here, not on
  // Rerun, so a stray Enter can't start a run; the next Tab reaches the page actions in order.
  const takeDroppedFocus = useCallback((node: HTMLDivElement | null) => {
    const active = node?.ownerDocument.activeElement
    if (node && (!active || active === node.ownerDocument.body)) {
      node.focus()
    }
  }, [])
  return (
    <div
      ref={takeDroppedFocus}
      role="status"
      tabIndex={-1}
      className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {confirmation.newerModel
        ? t(
            'automations.runModelFix.queuedWithNewerModel',
            "Run queued with the automation's latest model."
          )
        : t('automations.runModelFix.saved', 'Model set to {{model}} for this automation.', {
            model: confirmation.model
          })}
    </div>
  )
}
