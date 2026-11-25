// The line that replaces the failure banner once a picked model is saved.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { AutomationRunModelConfirmation } from './automation-run-model-fix'

export function AutomationRunModelConfirmationNotice({
  confirmation,
  focusRef
}: {
  confirmation: AutomationRunModelConfirmation
  /** Lands focus here when the picker that had it is replaced, not on Rerun, so a stray Enter
   *  can't start a run; the next Tab reaches the page actions in order. */
  focusRef?: (node: HTMLDivElement | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      ref={focusRef}
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
