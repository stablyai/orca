import { useCallback, useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { useAppStore } from '../store'
import { translate } from '@/i18n/i18n'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import { ResumeTreeRow } from './NativeChatResumeTreeRow'
import { moveInResumeTree } from './native-chat-resume-tree-keyboard'
import { resumeTreeMachines, resumeTreeRowAction } from './native-chat-resume-tree-machines'
import type { ResumeFailureAction } from './native-chat-resume-failure-guidance'
import { consumeNativeChatResumeOnRestartDialogRequest } from './native-chat-resume-on-restart-dialog'
import {
  continueNativeChatRestartOffers,
  dismissNativeChatRestartOffer
} from './native-chat-restart-offer-actions'
import {
  releaseFinishedNativeChatRestartRuns,
  useNativeChatRestartResuming
} from './native-chat-restart-runs'
import { useResumeRunPanel } from './NativeChatResumeRunPanel'
import type { MachineView } from './native-chat-resume-machine-views'
import { useNativeChatResumeDialogOpening } from './native-chat-resume-dialog-opening'
import { actOnResumeRow } from './native-chat-resume-failure-action'
import { resumeSelectionState } from './native-chat-resume-on-restart-grouping'
import {
  chosenResumeRows,
  dismissedRows,
  resumeRowKey,
  selectableResumeRows
} from './native-chat-resume-selection'

/**
 * What would be resumed, shown before anything runs — on every machine with chats to resume.
 *
 * Resuming reattaches a chat AND asks the agent to carry on, so the list is the point: the user
 * sees which chats each machine's last teardown recorded as mid-turn before a message goes
 * anywhere. Every string here has to say that a message is sent and that the user's own prompt is
 * not re-sent.
 *
 * Each machine is a row with a select-all box, opening onto its workspaces and chats; every box,
 * from Select all down to each chat, sits in one left column. The user's own chats start ticked;
 * chats another device, an automation or the server itself started are listed unticked with where
 * they came from, and Select all counts and ticks them like any other. Only this computer, alone,
 * keeps the flat list.
 *
 * The "don't ask again" box removes the PROMPT, never a safety check — an opted-in launch or
 * reconnect calls the same RPC, which re-derives the same predicate and staggers the same way.
 *
 * Resume closes the dialog at once and the status-bar entry carries the run, then any chat it could
 * not carry on. Each machine's run lives in the store, so the dialog is one view of them: reopened
 * mid-run, each chat in one shows where it stands in its checkbox's place, and the dialog stays on
 * those runs until it is closed after they have finished.
 *
 * A chat an earlier resume could not carry on is listed too, as the same row plus what went wrong
 * and what to do; selecting it and resuming is a retry. Row actions act on their row and leave the
 * dialog open. It closes only on the user's own way out, or once no machine has anything left.
 *
 * Closing is a SNOOZE, so looking around before deciding cannot remove the recovery. Dismiss is the
 * explicit path that deletes the durable records, and only the user's own; any other chat ends when
 * it moves on, when its tab is closed, or by its own row's dismiss.
 */

/** Says where the chats were cut off: on several machines, by this computer's update, or its close. */
function resumeDialogBody(flat: boolean, interruptedByUpdate: boolean): string {
  if (!flat) {
    return translate(
      'auto.components.NativeChatResumeOnRestartModal.machinesBody',
      'These chats were working when Orca on their machine closed or installed an update. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
    )
  }
  return interruptedByUpdate
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.updateBody',
        'These chats were working when Orca installed an update. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.body',
        'These chats were working when Orca closed. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
      )
}

/** Mid-run with nothing left to choose, the button says the run is going rather than "Resume 0". */
function resumeButtonLabel(chosenCount: number, running: boolean): string {
  if (chosenCount === 0 && running) {
    return translate('auto.components.NativeChatResumeOnRestartModal.resuming', 'Resuming…')
  }
  return chosenCount === 1
    ? translate('auto.components.NativeChatResumeOnRestartModal.resumeSelectedOne', 'Resume 1 chat')
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.resumeSelected',
        'Resume {{value0}} chats',
        { value0: chosenCount }
      )
}

export function NativeChatResumeOnRestartModal(): React.JSX.Element | null {
  const { machines, runs, request, showing } = useNativeChatResumeDialogOpening()
  const updateSettings = useAppStore((store) => store.updateSettings)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const resumeButtonRef = useRef<HTMLButtonElement>(null)
  // The store's: the resume outlives this dialog, which can close or reopen mid-run. Busy is per
  // machine, so one slow server never locks this computer's chats.
  const resuming = useNativeChatRestartResuming()
  const allBusy = machines.length > 0 && machines.every((machine) => resuming.has(machine.machine))
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  // Each opening starts from the rows' defaults. This component never unmounts, so an untick made
  // before a close would otherwise greet a reopen, e.g. as "Resume 0 chats" over what a run left.
  // Keyed on the request and the machine it was opened for.
  const opening = request ? `open\u0000${request.focus ?? ''}` : null
  const [openedWith, setOpenedWith] = useState(opening)
  if (openedWith !== opening) {
    setOpenedWith(opening)
    if (opening) {
      setOverrides(new Map())
    }
  }
  const chosen = useMemo(
    () =>
      machines
        .filter((machine) => !resuming.has(machine.machine))
        .map((machine) => ({
          machine,
          ids: chosenResumeRows(machine, overrides)
        })),
    [machines, overrides, resuming]
  )
  const dismissals = useMemo(
    () =>
      machines
        .filter((machine) => !resuming.has(machine.machine))
        .map((machine) => ({ machine, ids: dismissedRows(machine) })),
    [machines, resuming]
  )
  // "Dismiss all" only when it clears every chat listed; any chat not the user's own (another
  // device's, an automation's, the server's, or one whose owner the host could not say) stays, and
  // the button must not claim otherwise. With nothing of the user's listed it clears nothing, so it
  // stays put but disabled; each such row's own dismiss is the way out.
  const dismissesEverything = dismissals.every(
    (entry) => entry.ids.length === entry.machine.rows.length
  )
  const dismissesNothing = dismissals.every((entry) => entry.ids.length === 0)
  const chosenCount = chosen.reduce((total, entry) => total + entry.ids.length, 0)
  // One Select all across machines, over every chat a tick can name on a machine not mid-resume;
  // with every machine mid-resume it shows the run, as the rows below do, and stays disabled.
  const allSelection = useMemo(() => {
    const counted = allBusy
      ? machines.map((machine) => ({
          machine,
          ids: resuming.get(machine.machine) ?? []
        }))
      : chosen
    const keys = counted.flatMap(({ machine }) =>
      selectableResumeRows(machine).map((sessionId) => resumeRowKey(machine.identity, sessionId))
    )
    const ticked = new Set(
      counted.flatMap(({ machine, ids }) => ids.map((id) => resumeRowKey(machine.identity, id)))
    )
    return { keys, state: resumeSelectionState(keys, ticked) }
  }, [allBusy, chosen, machines, resuming])

  const runPanel = useResumeRunPanel({
    parts: machines.map((machine) => ({
      run: runs.get(machine.machine)?.run ?? null,
      rows: machine.rows,
      failureFor: machine.failureFor,
      keyOf: (sessionId: string) => resumeRowKey(machine.identity, sessionId)
    })),
    open: showing
  })

  const toggle = useCallback((key: string, checked: boolean) => {
    setOverrides((current) => new Map(current).set(key, checked))
  }, [])
  const setTicks = useCallback((keys: readonly string[], checked: boolean) => {
    setOverrides((current) => {
      const next = new Map(current)
      for (const key of keys) {
        next.set(key, checked)
      }
      return next
    })
  }, [])

  /** Applied on whichever action the user takes, so the box means the same thing every way out. */
  const persistPreference = useCallback(async (): Promise<void> => {
    if (dontAskAgain) {
      await updateSettings({ nativeChatResumeWorkOnRestart: true }).catch(() => undefined)
    }
  }, [dontAskAgain, updateSettings])

  /** Closing is a snooze: each host keeps its offer and the status bar keeps the way back. */
  const snooze = useCallback((): void => {
    consumeNativeChatResumeOnRestartDialogRequest()
    releaseFinishedNativeChatRestartRuns()
    void persistPreference()
  }, [persistPreference])

  const dismissAll = async (): Promise<void> => {
    void persistPreference()
    // Bookkeeping never gates the user's own action: the dialog closes here whatever each host
    // answers, rather than being trapped open behind a rejected promise.
    consumeNativeChatResumeOnRestartDialogRequest()
    releaseFinishedNativeChatRestartRuns()
    await Promise.all(
      dismissals
        .filter((entry) => entry.ids.length > 0)
        .map((entry) => dismissNativeChatRestartOffer(entry.machine.machine, entry.ids))
    )
  }

  const actOnFailure = (machine: MachineView, action: ResumeFailureAction, sessionId: string) =>
    actOnResumeRow(machine, action, sessionId, persistPreference)

  if (!request || !showing) {
    return null
  }

  const flat = machines.length === 1 && machines[0]!.offer.target.kind === 'local'
  const rowsAcrossMachines = machines.flatMap((machine) => machine.rows)
  const interruptedByUpdate = rowsAcrossMachines.some((row) => row.trigger === 'update')
  // While a run is followed, each machine shows its run's rows, which keep a chat its host has
  // already resumed and dropped from the list.
  const runRows = runPanel?.rows
  const tree = resumeTreeMachines(
    machines,
    resuming,
    request.focus,
    runRows ? (machine) => runRows[machines.indexOf(machine)] ?? machine.rows : undefined
  )
  // Group boxes count only chats still listed, never a run's finished history.
  const selectableIds = new Set(
    machines.flatMap((machine) =>
      selectableResumeRows(machine).map((sessionId) => resumeRowKey(machine.identity, sessionId))
    )
  )
  const ticked = new Set(
    machines.flatMap((machine) =>
      // Mid-run the ticks show what is running; this opening's own ticks may name chats left out.
      (
        resuming.get(machine.machine) ??
        chosen.find((entry) => entry.machine === machine)?.ids ??
        []
      ).map((sessionId) => resumeRowKey(machine.identity, sessionId))
    )
  )
  const selectAllLabel = translate(
    'auto.components.NativeChatResumeOnRestartModal.selectAllLabel',
    'Select all'
  )

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          snooze()
        }
      }}
    >
      {/* Height is capped, never the data: the list scrolls inside the dialog so the header and
          the primary action stay put however many chats were interrupted. */}
      {/* Wide enough for a nested chat row to keep its name, model and age on one line. */}
      <DialogContent
        className="grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-3xl max-h-[85vh]"
        // Keep the scrollable list out of initial focus, including while Resume is disabled.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const resumeButton = resumeButtonRef.current
          if (resumeButton && !resumeButton.disabled) {
            resumeButton.focus()
          } else if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {/* Plain wrapper owns the icon spacing; DialogTitle owns its own. */}
            {runPanel?.title ?? (
              <span className="flex items-center gap-2">
                <RotateCcw className="size-4 text-muted-foreground" />
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.title',
                  'Resume interrupted chats?'
                )}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {runPanel?.description ?? resumeDialogBody(flat, interruptedByUpdate)}
          </DialogDescription>
          {runPanel?.summary}
        </DialogHeader>

        <div
          role="tree"
          tabIndex={0}
          aria-label={translate(
            'auto.components.NativeChatResumeOnRestartModal.listLabel',
            'Chats that would be resumed'
          )}
          // The sidebar's own surface, so its workspaces read here as they do there.
          className="min-h-0 overflow-y-auto scrollbar-sleek rounded-md bg-worktree-sidebar p-1.5 pb-2"
          onKeyDown={moveInResumeTree}
        >
          {/* Here, not in the tree: one Select all for every machine listed. The tree's one divider
              sets it apart from the nodes. */}
          <div className="mb-1 border-b border-worktree-sidebar-border pb-0.5">
            <ResumeTreeRow
              depth={0}
              name={selectAllLabel}
              checked={allSelection.state.checked}
              disabled={allBusy || allSelection.state.total === 0}
              // Ticks everything unless all already are, as a node's box does.
              onCheckedChange={() =>
                setTicks(
                  allSelection.keys,
                  allSelection.state.selectedCount < allSelection.state.total
                )
              }
              checkboxLabel={translate(
                'auto.components.NativeChatResumeOnRestartModal.selectAll',
                'Select all chats'
              )}
            >
              <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">
                {selectAllLabel}
              </span>
              <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.selectedCount',
                  '{{value0}} of {{value1}} selected',
                  {
                    value0: allSelection.state.selectedCount,
                    value1: allSelection.state.total
                  }
                )}
              </span>
            </ResumeTreeRow>
          </div>
          {/* One tree over every machine: it shows a machine level whenever more than this
              computer is listed, each machine named, busy and opened on its own. */}
          <ResumeOnRestartGroups
            candidates={tree.rows}
            listedAt={tree.listedAt}
            busy={false}
            selected={ticked}
            onToggle={toggle}
            rowKey={tree.rowKey}
            busyFor={tree.busyFor}
            failureFor={tree.failureFor}
            onFailureAction={(action, key) =>
              resumeTreeRowAction(
                tree,
                key,
                (machine, act, sessionId) => {
                  void actOnFailure(machine, act, sessionId)
                },
                action
              )
            }
            originLabelFor={tree.originLabelFor}
            renderStatus={runPanel?.renderStatus}
            selectableIds={selectableIds}
            defaultExpanded={tree.defaultExpanded}
            machineSubtitle={tree.machineSubtitle}
            listingOf={tree.listingOf}
          />
        </div>

        {/* Two controls: one deletes the offers, one acts on them. Closing snoozes, so it needs none. */}
        <DialogFooter className="sm:items-center">
          {/* Why order-last: the narrow footer stacks bottom-up, so this keeps the option above the actions. */}
          <label className="order-last flex min-w-0 items-start gap-2.5 sm:order-none sm:mr-auto">
            <Checkbox
              checked={dontAskAgain}
              disabled={allBusy}
              onCheckedChange={(next) => setDontAskAgain(next === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm">
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.dontAskAgain',
                  "Don't ask again (resume automatically)"
                )}
              </span>
              {/* Where to undo it; what it does is the body copy's job. */}
              <span className="block text-xs text-muted-foreground">
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.dontAskAgainHint',
                  'You can turn this off in Settings → Experimental → Chat UI.'
                )}
              </span>
            </span>
          </label>
          {rowsAcrossMachines.length === 0 ? (
            // Only a finished run is left to look at.
            <Button ref={resumeButtonRef} variant="default" size="sm" onClick={snooze}>
              {translate('auto.components.NativeChatResumeOnRestartModal.done', 'Done')}
            </Button>
          ) : (
            <>
              {/* Quiet, explicit cleanup of the durable records. */}
              <Button
                variant="ghost"
                size="sm"
                disabled={allBusy || dismissesNothing}
                onClick={() => void dismissAll()}
              >
                {dismissesEverything
                  ? translate(
                      'auto.components.NativeChatResumeOnRestartModal.dismissAll',
                      'Dismiss all'
                    )
                  : translate('auto.components.NativeChatResumeOnRestartModal.dismiss', 'Dismiss')}
              </Button>
              <Button
                ref={resumeButtonRef}
                variant="default"
                size="sm"
                disabled={chosenCount === 0}
                onClick={() => {
                  // Resume hands the run to the status bar, and its result to one notice.
                  consumeNativeChatResumeOnRestartDialogRequest()
                  void persistPreference()
                  void continueNativeChatRestartOffers(
                    chosen.map((entry) => ({
                      machine: entry.machine.machine,
                      sessionIds: entry.ids
                    }))
                  )
                }}
              >
                {resumeButtonLabel(chosenCount, resuming.size > 0)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
