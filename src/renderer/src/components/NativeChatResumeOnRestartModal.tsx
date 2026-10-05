import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useNativeChatRestartOfferEnabled } from './native-chat-restart-offer-gate'
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
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import {
  resumeFailureGuidance,
  resumeFailureSelectable,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest,
  subscribeNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import {
  continueNativeChatRestartOffer,
  dismissNativeChatRestartOffer,
  useNativeChatRestartOffer,
  useNativeChatRestartResuming
} from './native-chat-resume-on-restart-store'

/**
 * What would be resumed, shown before anything runs.
 *
 * Resuming reattaches a chat AND asks the agent to carry on, so the list is the point: the user
 * sees which chats the last teardown recorded as mid-turn before a message goes anywhere. Every
 * string here has to say that a message is sent and that the user's own prompt is not re-sent.
 *
 * The "don't ask again" box removes the PROMPT, never a safety check — an opted-in launch calls
 * the same RPC, which re-derives the same predicate and staggers the same way.
 *
 * Resume closes the dialog at once and the status-bar entry carries the run, then any chat it could
 * not carry on. The run lives in the store, as a skill update's does, so the dialog is one view of it.
 *
 * A chat an earlier resume could not carry on is listed too, as the same row plus what went wrong
 * and what to do; selecting it and resuming is a retry, unless the host says a retry cannot run.
 * Row actions (Retry, Dismiss) act on their row and leave the dialog open. It closes only on the
 * user's own way out, or once the host confirms nothing is left; a resume settling never closes it.
 *
 * Closing is a SNOOZE, so looking around before deciding cannot remove the recovery. Dismiss all is
 * the explicit path that deletes the durable records.
 */

/** Pre-selected unless it is a failure a retry cannot fix; resuming that would only fail again. */
function selectedByDefault(failure: ResumeFailure | undefined): boolean {
  if (!failure) {
    return true
  }
  const guidance = resumeFailureGuidance(failure)
  return guidance.primary === 'retry' || guidance.secondary === 'retry'
}

export function NativeChatResumeOnRestartModal(): React.JSX.Element | null {
  const offerEnabled = useNativeChatRestartOfferEnabled()
  const { candidates, failed, listedAt } = useNativeChatRestartOffer(offerEnabled)
  const rows = useMemo<ResumeCandidate[]>(() => [...candidates, ...failed], [candidates, failed])
  const failureBySession = useMemo(
    () => new Map(failed.map((failure) => [failure.sessionId, failure])),
    [failed]
  )
  // Open is an external one-shot request, never mirrored into local state: the launch load and the
  // status-bar entry both raise it, and a copy here would go stale against whichever raised it last.
  const open = useSyncExternalStore(
    subscribeNativeChatResumeOnRestartDialog,
    getNativeChatResumeOnRestartDialogRequest,
    getNativeChatResumeOnRestartDialogRequest
  )
  const updateSettings = useAppStore((store) => store.updateSettings)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  // The store's: the resume outlives this dialog, which can close or reopen mid-run.
  const resuming = useNativeChatRestartResuming()
  const busy = resuming.length > 0
  /** The user's own ticks and unticks, over each row's default. Tracked as OVERRIDES rather than a
   *  selection because the list is the host's and arrives — and shrinks — under an open dialog; a
   *  stored selection would need seeding from an effect every time it changed. */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  // Each opening starts from the rows' defaults. This component never unmounts, so an untick made
  // before a close would otherwise greet a reopen, e.g. as "Resume 0 chats" over what a run left.
  const [openedWith, setOpenedWith] = useState(open)
  if (openedWith !== open) {
    setOpenedWith(open)
    if (open) {
      setOverrides(new Map())
    }
  }
  /** Derived from the host's own list, so an action can never name a chat it did not list. */
  const chosen = useMemo(
    () =>
      rows
        .filter((row) => {
          const failure = failureBySession.get(row.sessionId)
          // A tick made before the host marked it unretryable must not carry into the action.
          return (
            (!failure || resumeFailureSelectable(failure)) &&
            (overrides.get(row.sessionId) ?? selectedByDefault(failure))
          )
        })
        .map((row) => row.sessionId),
    [rows, overrides, failureBySession]
  )
  const selected = useMemo(() => new Set(chosen), [chosen])
  // Mid-run the ticks show what is running; this opening's own ticks may name chats left out of it.
  const ticked = useMemo(() => (busy ? new Set(resuming) : selected), [busy, resuming, selected])

  const toggleSelected = useCallback((sessionId: string, checked: boolean) => {
    setOverrides((current) => new Map(current).set(sessionId, checked))
  }, [])

  /** Applied on whichever action the user takes, so the box means the same thing every way out. */
  const persistPreference = useCallback(async (): Promise<void> => {
    if (dontAskAgain) {
      await updateSettings({ nativeChatResumeWorkOnRestart: true }).catch(() => undefined)
    }
  }, [dontAskAgain, updateSettings])

  // Never closes the dialog: only the user's own ways out do, and the store once nothing is left.
  const resume = useCallback(
    async (sessionIds: string[]): Promise<void> => {
      void persistPreference()
      await continueNativeChatRestartOffer(sessionIds)
    },
    [persistPreference]
  )

  /** Closing is a snooze: the host keeps the offer and the status bar keeps the way back to it. */
  const snooze = useCallback((): void => {
    consumeNativeChatResumeOnRestartDialogRequest()
    void persistPreference()
  }, [persistPreference])

  const dismissAll = useCallback(async (): Promise<void> => {
    void persistPreference()
    // Bookkeeping never gates the user's own action: the dialog closes here whatever the host
    // answers, rather than being trapped open behind a rejected promise.
    consumeNativeChatResumeOnRestartDialogRequest()
    await dismissNativeChatRestartOffer()
  }, [persistPreference])

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
    // Opening is read-only and keeps the record: the user's own send in that chat settles it. The
    // dialog gets out of the way of the chat it just opened.
    consumeNativeChatResumeOnRestartDialogRequest()
    await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: failure.workspaceId, sessionId }
    })
  }

  if (!offerEnabled || !open || rows.length === 0) {
    return null
  }

  const interruptedByUpdate = rows.some((row) => row.trigger === 'update')

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
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto_auto] sm:max-w-xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>
            {/* Plain wrapper owns the icon spacing; DialogTitle owns its own. */}
            <span className="flex items-center gap-2">
              <RotateCcw className="size-4 text-muted-foreground" />
              {translate(
                'auto.components.NativeChatResumeOnRestartModal.title',
                'Resume interrupted chats?'
              )}
            </span>
          </DialogTitle>
          <DialogDescription>
            {interruptedByUpdate
              ? translate(
                  'auto.components.NativeChatResumeOnRestartModal.updateBody',
                  'These chats were working when Orca installed an update. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
                )
              : translate(
                  'auto.components.NativeChatResumeOnRestartModal.body',
                  'These chats were working when Orca closed. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
                )}
          </DialogDescription>
        </DialogHeader>

        <div
          tabIndex={0}
          aria-label={translate(
            'auto.components.NativeChatResumeOnRestartModal.listLabel',
            'Chats that would be resumed'
          )}
          className="min-h-0 overflow-y-auto scrollbar-sleek rounded-md border bg-muted/35 p-1.5"
        >
          <ResumeOnRestartGroups
            candidates={rows}
            listedAt={listedAt}
            busy={busy}
            selected={ticked}
            onToggle={toggleSelected}
            failureFor={(sessionId) => failureBySession.get(sessionId)}
            onFailureAction={(action, sessionId) => void actOnFailure(action, sessionId)}
          />
        </div>

        <label className="flex items-start gap-2.5">
          <Checkbox
            checked={dontAskAgain}
            disabled={busy}
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

        {/* Two controls: one deletes the offer, one acts on it. Closing snoozes, so it needs none. */}
        <DialogFooter className="sm:justify-between">
          {/* Quiet, explicit cleanup of the durable records. */}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void dismissAll()}>
            {translate('auto.components.NativeChatResumeOnRestartModal.dismissAll', 'Dismiss all')}
          </Button>
          <Button
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
              ? translate('auto.components.NativeChatResumeOnRestartModal.resuming', 'Resuming…')
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
