import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { Info, RotateCcw } from 'lucide-react'
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
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { translate } from '@/i18n/i18n'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { AGENT_SESSION_RESTART_CONTINUATION_MESSAGE } from '../../../shared/agent-session-restart-continuation'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import {
  announceRestartDismissUnconfirmed,
  announceRestartResults,
  announceRestartUnconfirmed,
  type RestartActionOutcome
} from './native-chat-restart-action-notifications'
import { selectedResumeSessionIds } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest,
  subscribeNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import {
  clearNativeChatRestartOffer,
  settleNativeChatRestartOffer,
  useNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

/**
 * What would be reconnected, shown before anything runs.
 *
 * The list is the point. Reconnecting a chat that was not working starts a provider the user never
 * asked for and puts a misleading row in front of them, so they see exactly which chats the last
 * teardown recorded as mid-turn and decide. The checkbox is the opt-in to skipping this prompt in
 * future — it removes the PROMPT, never a safety check: automatic mode calls the same RPC, which
 * re-derives the same predicate and staggers the same way.
 *
 * Reconnecting restores the session at the point it stopped; it does NOT continue the interrupted
 * reply — that was measured. Every user-facing string here has to keep saying so.
 *
 * Closing is a SNOOZE: the host keeps the offer and the status bar keeps a way back to it, so
 * looking around before deciding cannot cost the recovery. Dismiss all is the only path that spends
 * it, and even that loses nothing — opening a chat takes a resume-capable hold, which re-acquires
 * the provider at the same cursor and retires the offer for it.
 */

// Structured sessions run on the machine hosting the runtime; both launch resolvers refuse anything
// else, so there is no remote target to aim this at.
const LOCAL = { kind: 'local' } as const

/** Shows the LITERAL message, read from the same constant the host sends, so the popover cannot
 *  drift into describing something other than what goes out. */
function ContinuationExplainer(): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={translate(
            'auto.components.NativeChatResumeOnRestartModal.whatIsSentTitle',
            'What Orca sends'
          )}
        >
          <Info className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <div className="space-y-2 p-3">
          <p className="text-xs font-semibold">
            {translate(
              'auto.components.NativeChatResumeOnRestartModal.whatIsSentTitle',
              'What Orca sends'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.NativeChatResumeOnRestartModal.whatIsSentBody',
              'Continuing sends one short message to each agent, telling it that Orca restarted and asking it to check its last action before carrying on. Your own prompt is never re-sent.'
            )}
          </p>
          <blockquote className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            {AGENT_SESSION_RESTART_CONTINUATION_MESSAGE}
          </blockquote>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function NativeChatResumeOnRestartModal(): React.JSX.Element | null {
  const structuredEnabled = useAppStore(
    (store) => store.settings?.experimentalStructuredNativeChat === true
  )
  const { candidates, listedAt } = useNativeChatRestartOffer(structuredEnabled)
  // Open is an external one-shot request, never mirrored into local state: the launch load and the
  // status-bar entry both raise it, and a copy here would go stale against whichever raised it last.
  const open = useSyncExternalStore(
    subscribeNativeChatResumeOnRestartDialog,
    getNativeChatResumeOnRestartDialogRequest,
    getNativeChatResumeOnRestartDialogRequest
  )
  const updateSettings = useAppStore((store) => store.updateSettings)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * Which of the OFFERED chats to leave out. Tracked as EXCLUSIONS rather than a selection because
   * the list is the host's and arrives — and shrinks — under an open dialog; a stored selection
   * would need seeding from an effect every time it changed.
   *
   * This changes which eligible chats are acted on, never what is eligible: the ids below are
   * intersected back against the host's own list, and the host re-derives the predicate regardless.
   */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set())
  const selected = useMemo(
    () =>
      new Set(
        candidates
          .map((candidate) => candidate.sessionId)
          .filter((sessionId) => !excluded.has(sessionId))
      ),
    [candidates, excluded]
  )

  const toggleSelected = useCallback((sessionId: string, checked: boolean) => {
    setExcluded((current) => {
      const next = new Set(current)
      if (checked) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
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

  const resume = useCallback(
    async (sessionIds: string[]): Promise<void> => {
      setBusy(true)
      try {
        void persistPreference()
        const result = await callStructuredAgentSession<{ results: RestartActionOutcome[] }>(
          LOCAL,
          'agentSession.restartResume',
          { sessionIds }
        )
        const settled = new Set(result.results.map((entry) => entry.sessionId))
        announceRestartResults(sessionIds, result.results, 'reconnect')
        settleNativeChatRestartOffer([...settled])
        // An empty result means the host settled none of them — never leave the dialog sitting open
        // behind a button that did nothing.
        if (
          settled.size === 0 ||
          candidates.every((candidate) => settled.has(candidate.sessionId))
        ) {
          consumeNativeChatResumeOnRestartDialogRequest()
        }
      } catch {
        announceRestartUnconfirmed(sessionIds.length, 'reconnect')
        consumeNativeChatResumeOnRestartDialogRequest()
      } finally {
        setBusy(false)
      }
    },
    [candidates, persistPreference]
  )

  /**
   * Reconnect AND ask each agent to carry on. A deliberate action only.
   *
   * The automatic path calls `restartResume`, which has no send in it, so no setting — the
   * checkbox included — can reach this. The checkbox opts into automatic RECONNECTION, never
   * automatic continuation.
   */
  const reconnectAndContinue = useCallback(
    async (sessionIds: string[]): Promise<void> => {
      setBusy(true)
      try {
        void persistPreference()
        const result = await callStructuredAgentSession<{
          /** Which chats the host actually reconnected, and so which claims it spent. Optional
           *  because the payload is unvalidated: a shape this side did not expect must not turn a
           *  delivered continuation into a failure report. */
          resumed?: RestartActionOutcome[]
          continued: RestartActionOutcome[]
        }>(LOCAL, 'agentSession.restartContinue', { sessionIds })
        announceRestartResults(sessionIds, result.continued, 'continue')
        // Continuing spends the same claims reconnecting does, so the offer has to shrink the same
        // way — otherwise the status bar keeps counting chats the host has already handed back.
        settleNativeChatRestartOffer((result.resumed ?? []).map((entry) => entry.sessionId))
      } catch {
        announceRestartUnconfirmed(sessionIds.length, 'continue')
      } finally {
        setBusy(false)
        consumeNativeChatResumeOnRestartDialogRequest()
      }
    },
    [persistPreference]
  )

  /** Closing is a snooze: the host keeps the offer and the status bar keeps the way back to it. */
  const snooze = useCallback((): void => {
    consumeNativeChatResumeOnRestartDialogRequest()
    void persistPreference()
  }, [persistPreference])

  /** The only path that spends the markers. */
  const dismissAll = useCallback(async (): Promise<void> => {
    setBusy(true)
    void persistPreference()
    // The dismissal is the user's and lands here, whatever the host answers. A write Orca cannot
    // confirm is reported rather than allowed to trap the dialog open behind a rejected promise.
    consumeNativeChatResumeOnRestartDialogRequest()
    try {
      await callStructuredAgentSession(LOCAL, 'agentSession.restartResumableDismiss', {})
      clearNativeChatRestartOffer()
    } catch {
      announceRestartDismissUnconfirmed()
    } finally {
      setBusy(false)
    }
  }, [persistPreference])

  if (!structuredEnabled || !open || candidates.length === 0) {
    return null
  }

  const interruptedByUpdate = candidates.some((candidate) => candidate.trigger === 'update')
  // Intersected against what the host offered, so an action can never name a chat it did not.
  const chosen = selectedResumeSessionIds(candidates, selected)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) {
          snooze()
        }
      }}
    >
      {/* Height is capped, never the data: seeing WHICH chats would be reconnected is the whole
          point, so the list scrolls inside the dialog while the header and primary action stay. */}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto_auto] sm:max-w-xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>
            {/* Plain wrapper owns the icon spacing; DialogTitle owns its own. */}
            <span className="flex items-center gap-2">
              <RotateCcw className="size-4 text-muted-foreground" />
              {translate(
                'auto.components.NativeChatResumeOnRestartModal.title',
                'Reconnect interrupted chats?'
              )}
            </span>
          </DialogTitle>
          <DialogDescription>
            {interruptedByUpdate
              ? translate(
                  'auto.components.NativeChatResumeOnRestartModal.updateBody',
                  'These chats were mid-turn when Orca installed an update. Reconnecting restores each one where it stopped, with its full context and without re-sending your prompt — the interrupted reply will not continue on its own.'
                )
              : translate(
                  'auto.components.NativeChatResumeOnRestartModal.body',
                  'These chats were mid-turn when Orca closed. Reconnecting restores each one where it stopped, with its full context and without re-sending your prompt — the interrupted reply will not continue on its own.'
                )}
          </DialogDescription>
          {/* The true state of things is counterintuitive — the terminal sessions survived and the
              chats did not — so say so where it frames the list, not as a footnote. "kept running"
              rather than "were restored": nothing reconnected them, they never stopped. */}
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.NativeChatResumeOnRestartModal.terminalSessionsUnaffected',
              'Only chats are affected — your terminal sessions kept running and need nothing from you.'
            )}
          </p>
        </DialogHeader>

        <div
          tabIndex={0}
          aria-label={translate(
            'auto.components.NativeChatResumeOnRestartModal.listLabel',
            'Chats that would be reconnected'
          )}
          className="min-h-0 overflow-y-auto scrollbar-sleek rounded-md border bg-muted/35 p-1.5"
        >
          <ResumeOnRestartGroups
            candidates={candidates}
            listedAt={listedAt}
            busy={busy}
            selected={selected}
            onToggle={toggleSelected}
          />
        </div>

        {/* Names both exits, because they are not the same: one keeps the offer, one spends it.
            Neither loses the chats themselves. */}
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.NativeChatResumeOnRestartModal.notNowHint',
            'Not now keeps this list in the status bar. Dismiss all clears it — either way you can reopen any chat later and carry on from the same point.'
          )}
        </p>

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
                "Don't ask again — reconnect automatically next time"
              )}
            </span>
            {/* Spelled out: a bare "don't ask again" reads as "stop bothering me", not as consent
                to run agents unattended. */}
            <span className="block text-xs text-muted-foreground">
              {translate(
                'auto.components.NativeChatResumeOnRestartModal.dontAskAgainHint',
                'Qualifying chats will be reconnected automatically after a restart, and Orca will tell you when it happens. You can turn this off in Settings → Experimental → Chat UI.'
              )}
            </span>
          </span>
        </label>

        {/* Two groups, not three buttons: the exits stay together on the left so "Not now" is not
            stranded between them and the actions. */}
        <DialogFooter className="sm:justify-between">
          <span className="flex items-center gap-1.5">
            {/* Quiet, not destructive: this spends an offer, and opening a chat still reconnects it. */}
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void dismissAll()}>
              {translate(
                'auto.components.NativeChatResumeOnRestartModal.dismissAll',
                'Dismiss all'
              )}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={snooze}>
              {translate('auto.components.NativeChatResumeOnRestartModal.notNow', 'Not now')}
            </Button>
          </span>
          <span className="flex items-center gap-1.5">
            <ContinuationExplainer />
            {/* Secondary, never the default: continuing sends a message, reconnecting does not. */}
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || chosen.length === 0}
              onClick={() => void reconnectAndContinue(chosen)}
            >
              {translate(
                'auto.components.NativeChatResumeOnRestartModal.reconnectAndContinue',
                'Reconnect and continue'
              )}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={busy || chosen.length === 0}
              onClick={() => void resume(chosen)}
            >
              {busy
                ? translate(
                    'auto.components.NativeChatResumeOnRestartModal.resuming',
                    'Reconnecting…'
                  )
                : chosen.length === candidates.length
                  ? translate(
                      'auto.components.NativeChatResumeOnRestartModal.resumeAll',
                      'Reconnect all'
                    )
                  : translate(
                      'auto.components.NativeChatResumeOnRestartModal.resumeSelected',
                      'Reconnect {{value0}}',
                      { value0: chosen.length }
                    )}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
