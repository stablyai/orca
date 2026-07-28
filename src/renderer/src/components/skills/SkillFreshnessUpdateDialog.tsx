import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Loader2, RefreshCw } from 'lucide-react'
import {
  buildTargetedSkillUpdateCommand,
  type SkillFreshnessInventory
} from '../../../../shared/skill-freshness'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { TooltipProvider } from '@/components/ui/tooltip'
import { groupSkillFreshness } from './skill-freshness-grouping'
import { SkillUpdateRow } from './SkillUpdateRow'
import { SummaryHeadline, summarizeInventory } from './skill-freshness-summary-headline'
import {
  acknowledgeSkillUpdateRun,
  cancelSkillUpdateRun,
  startSkillUpdateRun,
  useSkillUpdateRun
} from './skill-update-run-store'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  getSkillFreshnessUpdateDialogRequest,
  subscribeSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'

function RunLog({ output }: { output: string }): React.JSX.Element | null {
  if (!output.trim()) {
    return null
  }
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="group -ml-2 gap-1.5 text-muted-foreground"
        >
          <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
          {translate('auto.components.skills.SkillFreshnessUpdateDialog.showLog', 'Show log')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        {/* Displayed verbatim, never parsed — `skills update` has no --json. */}
        <pre className="scrollbar-sleek max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {output.trim()}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function SkillFreshnessUpdateDialog(): React.JSX.Element {
  const state = useSkillFreshness()
  const run = useSkillUpdateRun()
  const open = useSyncExternalStore(
    subscribeSkillFreshnessUpdateDialog,
    getSkillFreshnessUpdateDialogRequest,
    getSkillFreshnessUpdateDialogRequest
  )
  const [copied, setCopied] = useState(false)

  // Why: settling a run notifies every skills surface, and that refresh nulls the
  // inventory *synchronously* while it re-hashes each package on disk. Rendering
  // rows off the last good scan keeps them on screen through that window instead
  // of blanking the dialog at the exact moment the result appears. Eligibility
  // below still reads the live snapshot, so nothing is authorized off stale bytes.
  const lastInventoryRef = useRef<SkillFreshnessInventory | null>(null)
  if (state.inventory) {
    lastInventoryRef.current = state.inventory
  }
  const inventory = state.inventory ?? (state.loading ? lastInventoryRef.current : null)
  const eligibleNames = useMemo(() => state.inventory?.eligibleUpdateNames ?? [], [state.inventory])
  // Display only. The action still fires `eligibleNames`, so a re-scan in flight
  // can never authorize work — but the button keeps its place and its label
  // instead of vanishing and reflowing the footer every time one runs.
  const displayEligibleCount = inventory?.eligibleUpdateNames.length ?? 0
  const isRunning = run.state === 'running'
  // The kill sweep can take seconds; without this the Stop button sits enabled
  // and inert, which reads as broken.
  const isStopping = run.state === 'running' && run.stopping === true
  const showResult = run.state === 'success' || run.state === 'error'
  // Keyed on the names themselves: every captured output chunk republishes the
  // run, and regrouping the whole inventory per chunk would re-render each row.
  const runNamesKey = run.state === 'idle' ? '' : run.names.join('\n')
  const runNames = useMemo(() => (runNamesKey ? runNamesKey.split('\n') : []), [runNamesKey])
  const groups = useMemo(
    () =>
      inventory
        ? groupSkillFreshness(inventory.installations, inventory.eligibleUpdateNames, runNames)
        : [],
    [inventory, runNames]
  )
  const hasBlockedGroup = groups.some((group) => group.status === 'cannot-update')
  const blockedCount = groups.filter((group) => group.status === 'cannot-update').length
  // Why: the headline reads the LIVE snapshot, not the retained one — the two
  // disagree for the whole loading window, and pairing a retained "eligible" with
  // a live count of 0 renders "0 updates available" over rows badged "Update
  // available". Live means it says "Checking…" over the rows it kept on screen.
  const summaryKind = summarizeInventory(state.inventory, hasBlockedGroup)

  // Why: one row list for every state. The rows are identical objects across the
  // transition, so pressing Update changes each row's leading icon in place
  // instead of swapping the dialog's body for a different component.
  const failedNamesKey = run.state === 'error' ? run.failedNames.join('\n') : ''
  const rows = useMemo(() => {
    const failed = new Set(failedNamesKey ? failedNamesKey.split('\n') : [])
    const inRun = new Set(runNames)
    return groups.map((group) => {
      if (inRun.has(group.name)) {
        if (isRunning) {
          return { group, state: 'pending' as const }
        }
        return { group, state: failed.has(group.name) ? ('failed' as const) : ('done' as const) }
      }
      return {
        group,
        state: group.status === 'cannot-update' ? ('blocked' as const) : ('available' as const)
      }
    })
  }, [groups, isRunning, failedNamesKey, runNames])

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      return
    }
    // Why: closing never cancels. The run is owned by main and keeps going; the
    // status-bar segment carries it from here.
    consumeSkillFreshnessUpdateDialogRequest()
    setCopied(false)
    // Don't carry a finished session's rows into the next open — but a live run
    // keeps its own, or reopening from the status segment mid-run would land on
    // an empty list while the close's own re-scan is still reading disk.
    if (run.state === 'idle') {
      lastInventoryRef.current = null
    }
    if (showResult) {
      void acknowledgeSkillUpdateRun()
    }
    notifyInstalledAgentSkillsChanged()
  }

  const handleUpdate = (names: readonly string[]): void => {
    void startSkillUpdateRun(names)
  }

  const handleCopyCommand = (): void => {
    const command = buildTargetedSkillUpdateCommand(
      run.state === 'error' ? run.failedNames : eligibleNames
    )
    if (!command) {
      return
    }
    // Clipboard writes reject on a denied permission or an unfocused document;
    // without this the button just never flips to "Copied".
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch((error: unknown) => {
        console.error('Failed to copy skill update command', error)
      })
  }

  const headline = ((): React.JSX.Element => {
    if (isStopping) {
      // Why: no "keeps running in the background" line here — after Stop that is
      // the opposite of what is happening.
      return (
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          {translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.stoppingHeadline',
            'Stopping the update…'
          )}
        </div>
      )
    }
    if (isRunning) {
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            {run.names.length === 1
              ? translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.runningOne',
                  'Updating 1 skill…'
                )
              : translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.runningMany',
                  'Updating {{value0}} skills…',
                  { value0: run.names.length }
                )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.runningDescription',
              'You can close this window — it keeps running in the background.'
            )}
          </p>
        </div>
      )
    }
    if (run.state === 'success') {
      return (
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          {run.names.length === 1
            ? translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.updatedOne',
                'Updated 1 skill'
              )
            : translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.updatedMany',
                'Updated {{value0}} skills',
                { value0: run.names.length }
              )}
        </div>
      )
    }
    if (run.state === 'error') {
      const updated = run.names.length - run.failedNames.length
      return (
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="size-4 text-destructive" />
          {translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.updatedPartial',
            'Updated {{value0}} of {{value1}} skills',
            { value0: updated, value1: run.names.length }
          )}
        </div>
      )
    }
    return (
      <SummaryHeadline
        kind={summaryKind}
        eligibleCount={eligibleNames.length}
        blockedCount={blockedCount}
      />
    )
  })()

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="scrollbar-sleek max-h-[85vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.skills.SkillFreshnessUpdateDialog.title', 'Update skills')}
          </DialogTitle>
        </DialogHeader>

        {state.error && !isRunning && !showResult ? (
          <p className="text-xs text-destructive">{state.error}</p>
        ) : (
          headline
        )}

        {isRunning ? (
          // Indeterminate on purpose: the CLI reports no parseable progress.
          <div
            role="progressbar"
            aria-label={
              isStopping
                ? translate(
                    'auto.components.skills.SkillFreshnessUpdateDialog.stoppingHeadline',
                    'Stopping the update…'
                  )
                : translate(
                    'auto.components.skills.SkillFreshnessUpdateDialog.progressAria',
                    'Updating skills'
                  )
            }
            className="h-1 overflow-hidden rounded-full bg-secondary"
          >
            <div className="h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className={`min-w-0 ${isRunning ? '' : 'border-t border-border/60'}`}>
            <TooltipProvider>
              {rows.map((row) => (
                <SkillUpdateRow key={row.group.name} group={row.group} state={row.state} />
              ))}
            </TooltipProvider>
          </div>
        ) : null}

        {run.state === 'error' ? (
          <div className="space-y-2.5 rounded-md border border-destructive/35 bg-destructive/10 p-3">
            <p className="text-[13px] font-medium text-foreground">
              {translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.errorTitle',
                "The update didn't finish"
              )}
            </p>
            <p className="break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
              {run.message}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {/* Retry what actually failed, not the live eligibility list —
                  the settling re-scan empties that for the whole window this
                  button is on screen, so retrying it would be a silent no-op. */}
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => handleUpdate(run.failedNames)}
              >
                {translate('auto.components.skills.SkillFreshnessUpdateDialog.retry', 'Retry')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="gap-1.5"
                onClick={handleCopyCommand}
              >
                <Copy className="size-3.5" />
                {copied
                  ? translate('auto.components.skills.SkillFreshnessUpdateDialog.copied', 'Copied')
                  : translate(
                      'auto.components.skills.SkillFreshnessUpdateDialog.copyCommand',
                      'Copy command'
                    )}
              </Button>
            </div>
          </div>
        ) : null}

        {isRunning || showResult ? <RunLog output={run.output} /> : null}

        <DialogFooter className="sm:justify-between">
          {isRunning ? (
            // The terminal used to be the escape hatch for a stalled update;
            // without it a wedged npx would leave restarting Orca as the only way out.
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isStopping}
              onClick={() => void cancelSkillUpdateRun()}
            >
              {isStopping
                ? translate(
                    'auto.components.skills.SkillFreshnessUpdateDialog.stopping',
                    'Stopping…'
                  )
                : translate('auto.components.skills.SkillFreshnessUpdateDialog.stop', 'Stop')}
            </Button>
          ) : showResult ? (
            <span />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={state.loading}
              onClick={() => void state.refresh()}
            >
              <RefreshCw className={state.loading ? 'animate-spin' : undefined} />
              {translate('auto.components.skills.SkillFreshnessUpdateDialog.checkNow', 'Re-check')}
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
              {run.state === 'success'
                ? translate('auto.components.skills.SkillFreshnessUpdateDialog.done', 'Done')
                : translate('auto.components.skills.SkillFreshnessUpdateDialog.close', 'Close')}
            </Button>
            {!showResult && displayEligibleCount > 0 ? (
              <Button
                type="button"
                size="sm"
                disabled={isRunning || eligibleNames.length === 0}
                onClick={() => handleUpdate(eligibleNames)}
              >
                {/* Not during a stop: the Stop button already carries the status,
                    and "Updating…" beside "Stopping…" says both at once. */}
                {isRunning && !isStopping
                  ? translate(
                      'auto.components.skills.SkillFreshnessUpdateDialog.updating',
                      'Updating…'
                    )
                  : displayEligibleCount === 1
                    ? translate(
                        'auto.components.skills.SkillFreshnessUpdateDialog.updateActionOne',
                        'Update 1 skill'
                      )
                    : translate(
                        'auto.components.skills.SkillFreshnessUpdateDialog.updateActionMany',
                        'Update {{value0}} skills',
                        { value0: displayEligibleCount }
                      )}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
