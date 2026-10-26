import { NativeChatResumeDialogHeader } from './NativeChatResumeDialogHeader'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogFooter } from './ui/dialog'
import { useAppStore } from '../store'
import { translate } from '@/i18n/i18n'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import { ResumeTreeRow } from './NativeChatResumeTreeRow'
import {
  resumeFailureGuidance,
  resumeFailureSelectable,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'
import {
  resumeSelectionState,
  toggleResumeSelection,
  type ResumeCandidate,
  type ResumeFailure
} from './native-chat-resume-on-restart-grouping'
import {
  useNativeChatRestartOffer,
  useNativeChatRestartResuming,
  useNativeChatRestartRun,
  type NativeChatRestartStore
} from './native-chat-resume-on-restart-store'
import { useResumeRunPanel } from './NativeChatResumeRunPanel'
import { resumeRunFailures } from './native-chat-resume-run-view'
import { NativeChatResumeAutoNote } from './NativeChatResumeAutoNote'
import { NativeChatRemoteResumeActions } from './NativeChatRemoteResumeActions'
import { moveInTree } from './native-chat-resume-tree-keys'

/** Resume reattaches and sends a continuation, never the original user prompt; disclose this before sending. Automatic preference skips the prompt but uses the same host safety checks.
 * The store owns runs across dialog closes. Closing snoozes; Dismiss all deletes durable offers. Row Retry/Dismiss keep the dialog open, and settled runs cannot close a user-reopened dialog. Unretryable failures stay outside Resume. */

/** Pre-selected unless it is a failure a retry cannot fix; resuming that would only fail again. */
function selectedByDefault(failure: ResumeFailure | undefined): boolean {
  if (!failure) {
    return true
  }
  const guidance = resumeFailureGuidance(failure)
  return guidance.primary === 'retry' || guidance.secondary === 'retry'
}

export function NativeChatResumeOccurrenceModal({
  store,
  machineName,
  offerEnabled
}: {
  store: NativeChatRestartStore
  machineName?: string
  offerEnabled: boolean
}): React.JSX.Element | null {
  const {
    continueNativeChatRestartOffer,
    dismissNativeChatRestartOffer,
    markFinishedNativeChatRestartRunShown,
    releaseFinishedNativeChatRestartRun,
    consumeNativeChatResumeOnRestartDialogRequest,
    getNativeChatResumeOnRestartDialogRequest,
    subscribeNativeChatResumeOnRestartDialog
  } = store
  const remote = store.target.kind === 'environment'
  const { candidates, failed, listedAt } = useNativeChatRestartOffer(offerEnabled, store)
  const run = useNativeChatRestartRun(store)
  const rows = useMemo<ResumeCandidate[]>(() => [...candidates, ...failed], [candidates, failed])
  const failureBySession = useMemo(() => resumeRunFailures(run, failed), [run, failed])
  // Read one-shot open requests directly; a local mirror could go stale between launch and status-bar requests.
  const open = useSyncExternalStore(
    subscribeNativeChatResumeOnRestartDialog,
    getNativeChatResumeOnRestartDialogRequest,
    getNativeChatResumeOnRestartDialogRequest
  )
  const updateSettings = useAppStore((store) => store.updateSettings)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const autoResumeOn = useAppStore(
    (store) => store.settings?.nativeChatResumeWorkOnRestart === true
  )
  const resumeButtonRef = useRef<HTMLButtonElement>(null)
  // The store's: the resume outlives this dialog, which can close or reopen mid-run.
  const resuming = useNativeChatRestartResuming(store)
  const busy = resuming.length > 0
  /** Track overrides over host-derived defaults because the live offer can arrive/shrink while open; avoid effect-seeded selections. */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  // Reset overrides each opening; this retained component would otherwise reopen with stale unticks.
  const [openedWith, setOpenedWith] = useState(open)
  if (openedWith !== open) {
    setOpenedWith(open)
    if (open) {
      setOverrides(new Map())
    }
  }
  /** Every chat a tick can name; a failure the host marks unretryable is left out. */
  const selectable = useMemo(
    () =>
      rows
        .filter((row) => {
          const failure = failureBySession.get(row.sessionId)
          return !failure || resumeFailureSelectable(failure)
        })
        .map((row) => row.sessionId),
    [rows, failureBySession]
  )
  /** Derived from the host's own list, so an action can never name a chat it did not list. */
  const chosen = useMemo(
    () =>
      // A tick made before the host marked it unretryable must not carry into the action.
      selectable.filter(
        (sessionId) =>
          overrides.get(sessionId) ?? selectedByDefault(failureBySession.get(sessionId))
      ),
    [selectable, overrides, failureBySession]
  )
  const selectableIds = useMemo(() => new Set(selectable), [selectable])
  const selected = useMemo(() => new Set(chosen), [chosen])
  // Mid-run the ticks show what is running; this opening's own ticks may name chats left out of it.
  const ticked = useMemo(() => (busy ? new Set(resuming) : selected), [busy, resuming, selected])
  const failureFor = useCallback(
    (sessionId: string) => failureBySession.get(sessionId),
    [failureBySession]
  )
  const runPanel = useResumeRunPanel({
    run,
    rows,
    failureFor,
    selectableIds,
    open
  })
  useEffect(() => {
    if (offerEnabled && open && run && runPanel?.finishedRowsVisible) {
      markFinishedNativeChatRestartRunShown(run)
    }
  }, [
    offerEnabled,
    open,
    run,
    runPanel?.finishedRowsVisible,
    markFinishedNativeChatRestartRunShown
  ])
  const allSelection = resumeSelectionState(selectable, ticked)
  const choosing = runPanel?.choosing ?? true
  // While the setting is off the box stays, before and after Resume; an automatic run explains itself.
  const showDontAskAgain = !remote && !autoResumeOn && runPanel?.startedBy !== 'launch'

  const toggleSelected = useCallback((sessionId: string, checked: boolean) => {
    setOverrides((current) => new Map(current).set(sessionId, checked))
  }, [])

  /** Consume the box's choice once; a hidden box must never replay. */
  const persistPreference = useCallback(async (): Promise<void> => {
    if (dontAskAgain && showDontAskAgain) {
      setDontAskAgain(false)
      await updateSettings({ nativeChatResumeWorkOnRestart: true }).catch(() => undefined)
    }
  }, [dontAskAgain, showDontAskAgain, updateSettings])

  // Never closes the dialog: only the user's own ways out do, and the store once nothing is left.
  const resume = useCallback(
    async (sessionIds: string[]): Promise<void> => {
      void persistPreference()
      await continueNativeChatRestartOffer(sessionIds)
    },
    [persistPreference, continueNativeChatRestartOffer]
  )

  /** Closing is a snooze: the host keeps the offer and the status bar keeps the way back to it. */
  const snooze = useCallback((): void => {
    consumeNativeChatResumeOnRestartDialogRequest()
    releaseFinishedNativeChatRestartRun()
    void persistPreference()
  }, [
    persistPreference,
    consumeNativeChatResumeOnRestartDialogRequest,
    releaseFinishedNativeChatRestartRun
  ])

  const dismissAll = useCallback(async (): Promise<void> => {
    void persistPreference()
    // Close regardless of dismissal bookkeeping failure; rejected promises must not trap the dialog.
    consumeNativeChatResumeOnRestartDialogRequest()
    releaseFinishedNativeChatRestartRun()
    await dismissNativeChatRestartOffer()
  }, [
    persistPreference,
    consumeNativeChatResumeOnRestartDialogRequest,
    releaseFinishedNativeChatRestartRun,
    dismissNativeChatRestartOffer
  ])

  const actOnFailure = async (action: ResumeFailureAction, sessionId: string): Promise<void> => {
    if (action === 'dismiss') {
      await dismissNativeChatRestartOffer([sessionId])
      return
    }
    if (action === 'retry') {
      await resume([sessionId])
      return
    }
    const failure = failureBySession.get(sessionId)
    if (!failure) {
      return
    }
    // Opening is read-only; the user’s send settles the record. Clear the dialog so the chat is visible.
    consumeNativeChatResumeOnRestartDialogRequest()
    releaseFinishedNativeChatRestartRun()
    const session = { structuredSession: { workspaceId: failure.workspaceId, sessionId } }
    await (remote
      ? activateAiVaultStructuredSession(session, undefined, store.target)
      : activateAiVaultStructuredSession(session))
  }

  if (!offerEnabled || !open || (rows.length === 0 && !runPanel)) {
    return null
  }

  const interruptedByUpdate = rows.some((row) => row.trigger === 'update')
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
      {/* Scroll the full list while retaining header/actions; allow width for nested chat name/model/age. */}
      {/* Keep nested chat names, models and ages on one line. */}
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
        <NativeChatResumeDialogHeader
          runPanel={runPanel}
          machineName={machineName}
          remote={remote}
          interruptedByUpdate={interruptedByUpdate}
        />

        <div
          role="tree"
          tabIndex={0}
          aria-label={
            choosing
              ? translate(
                  'auto.components.NativeChatResumeOnRestartModal.listLabel',
                  'Chats that would be resumed'
                )
              : translate(
                  'auto.components.NativeChatResumeOnRestartModal.resultListLabel',
                  'Chats in this resume'
                )
          }
          // Match the sidebar’s workspace surface.
          className="min-h-0 overflow-y-auto scrollbar-sleek rounded-md bg-worktree-sidebar p-1.5 pb-2"
          onKeyDown={moveInTree}
        >
          {/* One Select all divider for the whole tree, including multiple machines. */}
          {choosing && !remote && (
            <div className="mb-1 border-b border-worktree-sidebar-border pb-0.5">
              <ResumeTreeRow
                depth={0}
                name={selectAllLabel}
                checked={allSelection.checked}
                disabled={busy || allSelection.total === 0}
                onCheckedChange={() =>
                  toggleResumeSelection(selectable, allSelection, toggleSelected)
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
                    { value0: allSelection.selectedCount, value1: allSelection.total }
                  )}
                </span>
              </ResumeTreeRow>
            </div>
          )}
          <ResumeOnRestartGroups
            key={run?.inFlight ? 'running' : 'finished'}
            candidates={runPanel?.rows ?? rows}
            listedAt={listedAt}
            busy={busy}
            selected={ticked}
            onToggle={toggleSelected}
            failureFor={failureFor}
            onFailureAction={(action, sessionId) => void actOnFailure(action, sessionId)}
            renderStatus={runPanel?.renderStatus}
            selectableIds={selectableIds}
            selecting={choosing && !remote}
          />
        </div>

        {/* Closing already snoozes; footer actions explicitly dismiss or resume. */}
        <DialogFooter className="sm:items-center">
          {runPanel?.startedBy === 'launch' ? (
            <NativeChatResumeAutoNote inFlight={busy} onOpenSettings={snooze} />
          ) : (
            showDontAskAgain && (
              // Narrow footers stack bottom-up; order-last keeps the preference above actions.
              <label className="order-last flex min-w-0 items-start gap-2.5 sm:order-none sm:mr-auto">
                <Checkbox
                  checked={dontAskAgain}
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
                  {/* Link to reversal settings; body copy explains the action. */}
                  <span className="block text-xs text-muted-foreground">
                    {translate(
                      'auto.components.NativeChatResumeOnRestartModal.dontAskAgainHint',
                      'You can turn this off in Settings → Experimental → Chat UI.'
                    )}
                  </span>
                </span>
              </label>
            )
          )}
          {rows.length === 0 || (run?.inFlight === false && !choosing) ? (
            <Button ref={resumeButtonRef} variant="default" size="sm" onClick={snooze}>
              {translate('auto.components.NativeChatResumeOnRestartModal.done', 'Done')}
            </Button>
          ) : remote ? (
            <NativeChatRemoteResumeActions
              resumeButtonRef={resumeButtonRef}
              store={store}
              machineName={machineName ?? ''}
              chosen={chosen}
              busy={busy}
              resume={(ids) => {
                consumeNativeChatResumeOnRestartDialogRequest()
                void resume(ids)
              }}
              dismiss={snooze}
            />
          ) : (
            <>
              {/* Dismiss deletes durable records rather than snoozing them. */}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void dismissAll()}>
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.dismissAll',
                  'Dismiss all'
                )}
              </Button>
              <Button
                ref={resumeButtonRef}
                variant="default"
                size="sm"
                disabled={busy || chosen.length === 0}
                onClick={() => {
                  // Resume hands the run to the status bar.
                  consumeNativeChatResumeOnRestartDialogRequest()
                  void resume(chosen)
                }}
              >
                {busy
                  ? translate(
                      'auto.components.NativeChatResumeOnRestartModal.resuming',
                      'Resuming…'
                    )
                  : chosen.length === 1
                    ? translate(
                        'auto.components.NativeChatResumeOnRestartModal.resumeSelectedOne',
                        'Resume 1 chat'
                      )
                    : translate(
                        'auto.components.NativeChatResumeOnRestartModal.resumeSelected',
                        'Resume {{value0}} chats',
                        { value0: chosen.length }
                      )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
