import React from 'react'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { VmBuildReveal } from './VmBuildReveal'
import { isAccountGate, type VmBuildFailure } from './vm-build-failure'
import { vmBuildFailureCopy } from './vm-build-failure-copy'
import { FailureActionRow, type VmBuildFailureActions } from './VmBuildFailureActions'
import { CheckRow } from './VmBuildCheckRow'

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
    ? vmBuildFailureCopy(visible, { cloud, canManageBilling, repoName }, t)
    : null
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const cardRef = React.useRef<HTMLDivElement>(null)
  // Move focus to the card when it opens, so keyboard and screen-reader users land on the way forward.
  React.useEffect(() => {
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
  const detail =
    visible?.kind === 'provision' && !cloud && firstErrorLine && firstErrorLine !== copy?.body
      ? firstErrorLine
      : null

  return (
    <VmBuildReveal open={failure !== null} className="pt-4">
      {visible && copy ? (
        <div
          key={run}
          ref={cardRef}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          {/* Only the cause is announced; the actions and check rows are read on demand. */}
          <div role={failure ? 'alert' : undefined} className="flex flex-col gap-1">
            <h3
              ref={headingRef}
              tabIndex={-1}
              className={cn(
                'text-sm font-medium outline-none',
                isAccountGate(visible) ? 'text-foreground' : 'text-destructive'
              )}
            >
              {copy.title}
            </h3>
            {copy.body ? (
              <p className="break-words text-xs text-muted-foreground">{copy.body}</p>
            ) : null}
            {detail ? (
              <p className="break-words font-mono text-[11px] text-destructive">{detail}</p>
            ) : null}
          </div>
          {visible.kind === 'checks' ? (
            <ul key={run} className="flex flex-col gap-2">
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
            <p className="text-xs text-muted-foreground">
              {cloud
                ? t(
                    'auto.components.worktree.creation.VmBuildFailureCard.stillRunningCloud',
                    'The sandbox is running and using sandbox hours until you choose.'
                  )
                : t(
                    'auto.components.worktree.creation.VmBuildFailureCard.stillRunningLocal',
                    'The VM is running and using hours until you choose.'
                  )}
            </p>
          ) : null}
        </div>
      ) : null}
    </VmBuildReveal>
  )
}
