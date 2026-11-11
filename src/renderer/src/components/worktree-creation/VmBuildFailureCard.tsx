import React from 'react'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate } from '@/i18n/use-translate'
import { VmBuildReveal } from './VmBuildReveal'
import { isAccountGate, localRawError, type VmBuildFailure } from './vm-build-failure'
import { getLastBillingStatus } from '@/components/billing/billing-summary-store'
import { sandboxLimitFromBilling, vmBuildFailureCopy } from './vm-build-failure-copy'
import { FailureActionRow, type VmBuildFailureActions } from './VmBuildFailureActions'
import { CheckRow } from './VmBuildCheckRow'
import { VmBuildErrorDetails } from './VmBuildErrorDetails'
import { BlockedSandboxHoursNote } from './BlockedSandboxHoursNote'

export type { VmBuildFailureActions }

/** Failure card for a VM build; keeps the last failure on screen while it collapses away. */
export function VmBuildFailureCard({
  failure,
  cloud,
  vmKept,
  firstErrorLine,
  canFixWithAgent,
  canManageBilling,
  signingIn,
  connectingGitHub,
  repoName,
  actions
}: {
  failure: VmBuildFailure | null
  /** Orca Cloud: plain language, and no recipe internals to edit. */
  cloud: boolean
  /** A VM is still up, so leaving destroys it. */
  vmKept: boolean
  /** First error in the build log, shown under a recipe's terse exit message. */
  firstErrorLine: string | null
  canFixWithAgent: boolean
  canManageBilling: boolean
  signingIn: boolean
  connectingGitHub: boolean
  /** How the user knows the repository, for cards that name it. */
  repoName: string
  actions: VmBuildFailureActions
}): React.JSX.Element {
  const t = useTranslate()
  // Why: a closing card still needs its content, or it would empty out before it finishes collapsing.
  const [shown, setShown] = React.useState(failure)
  // Each opening is a new run, so the rows remount and their stagger replays on a repeated failure.
  const [run, setRun] = React.useState(0)
  const [open, setOpen] = React.useState(failure !== null)
  if ((failure !== null) !== open) {
    setOpen(failure !== null)
    if (failure) {
      setRun(run + 1)
    }
  }
  if (failure && failure.kind !== shown?.kind) {
    setShown(failure)
  }
  const visible = failure ?? shown
  const copy = visible
    ? vmBuildFailureCopy(
        visible,
        {
          cloud,
          canManageBilling,
          repoName,
          sandboxLimit: sandboxLimitFromBilling(getLastBillingStatus()),
          sandboxKept: vmKept
        },
        t
      )
    : null
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const cardRef = React.useRef<HTMLDivElement>(null)
  // Move focus to the card when it opens, so keyboard and screen-reader users land on the way forward.
  // Layout effect: focus lands before paint, so the collapsing card never strands it on <body>.
  React.useLayoutEffect(() => {
    const card = cardRef.current
    const sheet = card?.closest('[data-vm-build-sheet]')
    const active = document.activeElement
    if (open) {
      // Never pull focus out of something the user is typing in elsewhere.
      if (!active || active === document.body || sheet?.contains(active)) {
        headingRef.current?.focus({ preventScroll: true })
      }
      return
    }
    // A Retry collapses (and inerts) the card under the focused button, so hand focus to the sheet.
    if (active && card?.contains(active)) {
      sheet?.querySelector<HTMLElement>('[data-vm-build-heading]')?.focus({ preventScroll: true })
    }
  }, [open, run])
  const rawError = cloud ? null : localRawError(visible, firstErrorLine)

  return (
    <VmBuildReveal open={failure !== null} className="pt-4">
      {visible && copy ? (
        <div key={run} ref={cardRef}>
          {/* InlineError announces only the cause; the check rows and actions are read on demand.
              An account limit isn't a broken build, so it reads as a neutral notice. */}
          <InlineError
            tone={isAccountGate(visible) ? 'neutral' : 'error'}
            className="break-words"
            title={
              <h3 ref={headingRef} tabIndex={-1} className="outline-none">
                {copy.title}
              </h3>
            }
            detail={copy.body}
          >
            {/* Keyed on the text so a new error starts collapsed again. */}
            {rawError ? <VmBuildErrorDetails key={rawError} text={rawError} /> : null}
            {visible.kind === 'checks' ? (
              <ul className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2">
                {visible.problems.map((check, index) => (
                  <CheckRow key={check.id} check={check} index={index} cloud={cloud} t={t} />
                ))}
              </ul>
            ) : null}
            <FailureActionRow
              failure={visible}
              cloud={cloud}
              vmKept={vmKept}
              canFixWithAgent={canFixWithAgent}
              canManageBilling={canManageBilling}
              signingIn={signingIn}
              connectingGitHub={connectingGitHub}
              actions={actions}
              t={t}
            />
            {visible.kind === 'checks' ? (
              cloud ? (
                <BlockedSandboxHoursNote sleepsAt={visible.sleepsAt} sandbox={visible.sandbox} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t(
                    'auto.components.worktree.creation.VmBuildFailureCard.stillRunningLocal2',
                    'The VM is running until you choose.'
                  )}
                </p>
              )
            ) : null}
          </InlineError>
        </div>
      ) : null}
    </VmBuildReveal>
  )
}
