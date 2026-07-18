import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent
} from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import { buildTargetedSkillUpdateCommand } from '../../../../shared/skill-freshness'
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
import { OnboardingInlineCommandTerminal } from '@/components/onboarding/OnboardingInlineCommandTerminal'
import { TooltipProvider } from '@/components/ui/tooltip'
import { groupSkillFreshness } from './skill-freshness-grouping'
import { SkillFreshnessGroup } from './skill-freshness-group'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  getSkillFreshnessUpdateDialogRequest,
  subscribeSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'

type FreshnessSummaryKind = 'loading' | 'empty' | 'eligible' | 'current' | 'attention'

function summarizeInventory(
  inventory: SkillFreshnessInventory | null,
  hasBlockedGroup: boolean
): FreshnessSummaryKind {
  if (!inventory) {
    return 'loading'
  }
  if (inventory.installations.length === 0) {
    return 'empty'
  }
  if (inventory.eligibleUpdateNames.length > 0) {
    return 'eligible'
  }
  // Why: with nothing eligible, the modal is either genuinely all-clear or has
  // out-of-date skills it can't safely update; the group filter already dropped
  // the up-to-date and unrecognized-only noise, so a blocked group is the signal.
  return hasBlockedGroup ? 'attention' : 'current'
}

function SummaryHeadline({
  kind,
  eligibleCount
}: {
  kind: FreshnessSummaryKind
  eligibleCount: number
}): React.JSX.Element {
  if (kind === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.checking',
          'Checking installed Orca skills…'
        )}
      </div>
    )
  }
  if (kind === 'empty') {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.none',
          'No installed Orca skills found.'
        )}
      </p>
    )
  }
  if (kind === 'current') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.success',
          'All installed Orca skills are up to date.'
        )}
      </div>
    )
  }
  if (kind === 'attention') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
          {translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.attention',
            'Some installed Orca skills were left out of the update.'
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.attentionDescription',
            'Open Update details to see why each one was skipped.'
          )}
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-foreground">
        {eligibleCount === 1
          ? translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updateOne',
              '1 skill can be updated safely'
            )
          : translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updateMany',
              '{{value0}} skills can be updated safely',
              { value0: eligibleCount }
            )}
      </p>
    </div>
  )
}

export function SkillFreshnessUpdateDialog(): React.JSX.Element {
  const state = useSkillFreshness()
  const open = useSyncExternalStore(
    subscribeSkillFreshnessUpdateDialog,
    getSkillFreshnessUpdateDialogRequest,
    getSkillFreshnessUpdateDialogRequest
  )
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null)
  const [awaitingExitRefresh, setAwaitingExitRefresh] = useState(false)
  const terminalSubmittedRef = useRef(false)
  const terminalWrapperRef = useRef<HTMLDivElement>(null)
  const terminalFocusTargetRef = useRef<HTMLElement | null>(null)
  const terminalAuthorizationWasPendingRef = useRef(false)
  const inventoryAtTerminalExitRef = useRef<SkillFreshnessInventory | null>(null)
  const inventory = state.inventory
  const eligibleNames = useMemo(() => inventory?.eligibleUpdateNames ?? [], [inventory])
  const groups = useMemo(
    () =>
      inventory ? groupSkillFreshness(inventory.installations, inventory.eligibleUpdateNames) : [],
    [inventory]
  )
  const hasBlockedGroup = groups.some((group) => group.status === 'cannot-update')
  const updateCommand = buildTargetedSkillUpdateCommand(eligibleNames)
  const summaryKind = summarizeInventory(inventory, hasBlockedGroup)
  const terminalAuthorizationPending =
    terminalCommand !== null &&
    !terminalSubmittedRef.current &&
    (state.loading ||
      state.error !== null ||
      inventory === null ||
      terminalCommand !== updateCommand)

  useEffect(() => {
    if (!open) {
      return
    }
    if (state.loading) {
      // Why: keep the PTY mounted across focus revalidation, but the inert
      // wrapper below prevents stale draft input until fresh authority returns.
      return
    }
    if (state.error || !inventory) {
      // Why: a scan invalidates the authorization behind an unsubmitted draft.
      // A failed scan cannot restore it, so stale drafts fail closed.
      if (!terminalSubmittedRef.current && terminalCommand !== null) {
        setTerminalCommand(null)
      }
      return
    }
    if (awaitingExitRefresh) {
      if (inventory === inventoryAtTerminalExitRef.current) {
        return
      }
      inventoryAtTerminalExitRef.current = null
      setAwaitingExitRefresh(false)
      return
    }
    if (terminalSubmittedRef.current || terminalCommand === updateCommand) {
      return
    }
    // Why: changing the shared onboarding terminal's command pastes it again.
    // Replace only an unsubmitted draft; a submitted command owns its PTY until exit.
    setTerminalCommand(updateCommand)
  }, [
    awaitingExitRefresh,
    inventory,
    open,
    state.error,
    state.loading,
    terminalCommand,
    updateCommand
  ])

  useEffect(() => {
    if (terminalCommand === null) {
      // Why: the dialog stays mounted while closed, so do not retain a detached
      // xterm subtree after the draft exits or loses authorization.
      terminalFocusTargetRef.current = null
    }
    const wasPending = terminalAuthorizationWasPendingRef.current
    terminalAuthorizationWasPendingRef.current = terminalAuthorizationPending
    if (!wasPending || terminalAuthorizationPending) {
      return
    }
    const focusTarget = terminalFocusTargetRef.current
    if (!focusTarget?.isConnected || !terminalWrapperRef.current?.contains(focusTarget)) {
      terminalFocusTargetRef.current = null
      return
    }
    // Why: Chromium drops focus when an ancestor becomes inert; unchanged
    // authorization should return focus to the preserved xterm instance.
    focusTarget.focus()
  }, [terminalAuthorizationPending, terminalCommand])

  const handleOpenChange = (next: boolean): void => {
    // Why: closing is the natural point to re-observe bytes so a completed update
    // clears the state and the lingering nudge does not fire again.
    if (!next) {
      consumeSkillFreshnessUpdateDialogRequest()
      terminalSubmittedRef.current = false
      inventoryAtTerminalExitRef.current = null
      setAwaitingExitRefresh(false)
      setTerminalCommand(null)
      notifyInstalledAgentSkillsChanged()
    }
  }

  const handleTerminalInteraction = (
    method: 'keyboard' | 'pointer',
    event?: KeyboardEvent<HTMLElement>
  ): void => {
    if (method === 'keyboard' && event?.key === 'Enter') {
      terminalSubmittedRef.current = true
    }
  }

  const handleTerminalExit = (): void => {
    terminalSubmittedRef.current = false
    inventoryAtTerminalExitRef.current = inventory
    setAwaitingExitRefresh(true)
    setTerminalCommand(null)
    notifyInstalledAgentSkillsChanged()
  }

  const hasVisibleGroups = groups.length > 0

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

        {state.error ? (
          <p className="text-xs text-destructive">{state.error}</p>
        ) : (
          <SummaryHeadline kind={summaryKind} eligibleCount={eligibleNames.length} />
        )}

        {terminalCommand ? (
          <div
            ref={terminalWrapperRef}
            data-skill-update-terminal=""
            aria-busy={terminalAuthorizationPending}
            inert={terminalAuthorizationPending}
            className={terminalAuthorizationPending ? 'opacity-50' : undefined}
            onFocusCapture={(event) => {
              terminalFocusTargetRef.current = event.target as HTMLElement
            }}
            onBlurCapture={(event) => {
              // Why: a concrete next target means the user moved focus; inert
              // uses a null target, which should be restored after revalidation.
              if (
                event.relatedTarget instanceof Node &&
                !event.currentTarget.contains(event.relatedTarget)
              ) {
                terminalFocusTargetRef.current = null
              }
            }}
          >
            <OnboardingInlineCommandTerminal
              key={terminalCommand}
              command={terminalCommand}
              title={translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.terminalTitle',
                'Update Orca skills'
              )}
              description={translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.terminalDescription',
                'Review the pre-filled command, then press Enter to run it.'
              )}
              ariaLabel={translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.terminalAria',
                'Orca skill update terminal'
              )}
              worktreeId="skill-freshness-update-terminal"
              terminalHeightPx={200}
              terminalTopMarginPx={0}
              autoScrollIntoView={false}
              onInteracted={handleTerminalInteraction}
              onTerminalExit={handleTerminalExit}
            />
          </div>
        ) : null}

        {/* Why: Radix reads defaultOpen only on mount. Remount when a scan
            becomes blocked so the required diagnostic details actually open. */}
        {hasVisibleGroups ? (
          <Collapsible key={hasBlockedGroup ? 'blocked' : 'default'} defaultOpen={hasBlockedGroup}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="group -ml-2 gap-1.5 text-muted-foreground"
              >
                <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                {translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.details',
                  'Update details'
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 divide-y divide-border/40 rounded-md border border-border/60 p-3">
              <TooltipProvider>
                {groups.map((group) => (
                  <SkillFreshnessGroup key={group.name} group={group} />
                ))}
              </TooltipProvider>
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        <DialogFooter className="sm:justify-between">
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
          <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.skills.SkillFreshnessUpdateDialog.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
