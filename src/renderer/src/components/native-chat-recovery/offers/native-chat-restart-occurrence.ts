import {
  EMPTY,
  dismissRestartHostOffer,
  readRestartHostOffer,
  restartOfferOnTarget,
  type NativeChatRestartOffer,
  type HostOfferRead
} from './native-chat-restart-host-offer'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { markNativeChatLaunchResumeDecided } from './native-chat-launch-resume-decision'
import {
  nextResumeRun,
  resumeRunInFlight,
  resumeRunPendingIds,
  settledResumeRun,
  unsentResumeIds,
  withoutResumeRunSessions,
  type ResumeRun,
  type ResumeRunStarter
} from '../runs/native-chat-resume-run'
import { createUnsentResumes } from './native-chat-resume-unsent-requests'
import * as dialog from '../dialogs/native-chat-resume-on-restart-dialog'
import { createOfferedChatWatch } from './native-chat-resume-offered-chat-watch'
import {
  createRemoteRestartOfferLifecycle,
  readDesktopCreatedChatIds
} from './native-chat-remote-restart-offer'
import {
  continueRestartChunks,
  NO_RESTART_CONTINUATION
} from '../runs/native-chat-restart-continuation-chunks'
import { watchResumeRunStatus } from '../runs/native-chat-resume-run-status-watch'
import { createRestartActionTurn } from './native-chat-restart-action-turn'

let nextOccurrence = 0

export function createNativeChatRestartOccurrence(
  target: RuntimeClientTarget,
  key: string,
  listeners: Set<() => void>
) {
  const requestNativeChatResumeOnRestartDialog = () =>
    dialog.requestNativeChatResumeOnRestartDialog(key)
  const consumeNativeChatResumeOnRestartDialogRequest = () =>
    dialog.consumeNativeChatResumeOnRestartDialogRequest(key)
  const identity = ++nextOccurrence
  let live = true
  const current = () => live
  let createdHere: Set<string> | null = null
  const { forgetUnsentResumes, markUnsentResumes, withUnsentResumes } = createUnsentResumes()
  let offer: NativeChatRestartOffer = EMPTY
  /** Continue and dismiss calls, begun and settled. Each ends by publishing the host's answer, which
   *  a re-read that raced it must neither pre-empt nor undo. */
  const turn = createRestartActionTurn()
  let readSequence = 0
  /** Memory-only history: retires after viewing and closing its finished summary, or on replacement. */
  let run: ResumeRun | null = null
  let releaseRunStatus: (() => void) | undefined
  let resuming: readonly string[] = resumeRunPendingIds(null)

  const emit = (): void => listeners.forEach((listener) => listener())

  /** The snapshot object is replaced HERE and nowhere else — never during a render — so every
   *  `useSyncExternalStore` reader sees the same reference until a host answer or a user action
   *  actually moves the offer. */
  function publish(next: NativeChatRestartOffer): void {
    if (!current()) {
      return
    }
    offer = next
    offeredChatWatch.sync()
    emit()
  }

  /** A confirmed host answer. One with nothing left also retires any open request for the dialog,
   *  unless it is showing a run; a failed read only hides rows, so it keeps the request. */
  function publishAnswer(answer: NativeChatRestartOffer): void {
    if (!current()) {
      return
    }
    const next = withUnsentResumes(restartOfferOnTarget(answer, target))
    if (next.candidates.length + next.failed.length === 0) {
      createdHere = null
    }
    publish(next)
    if (next.candidates.length === 0 && next.failed.length === 0 && run === null) {
      consumeNativeChatResumeOnRestartDialogRequest()
    }
  }

  function setRun(next: ResumeRun | null): void {
    if (!current()) {
      return
    }
    run = next
    const pending = resumeRunPendingIds(next)
    // Same ids, same array, so readers of `resuming` re-render only when it changes.
    resuming = pending.join('\0') === resuming.join('\0') ? resuming : pending
    emit()
  }

  // Re-reads once an offered or failed chat shows new activity. Skipped while an action is in
  // flight: that action ends by publishing the host's answer, which a racing re-read must not undo.
  const offeredChatWatch = createOfferedChatWatch({
    feed: () => getStructuredAgentSessionStatusFeed(target),
    offeredIds: () =>
      new Set([...offer.candidates, ...offer.failed].map((entry) => entry.sessionId)),
    listedAt: () => offer.listedAt,
    refresh: () => {
      if (current() && turn.idle()) {
        const issued = turn.begun()
        void readNativeChatRestartOffer(() => turn.begun() === issued)
      }
    }
  })

  /** A finished summary must be shown before closing can retire it. */
  function markFinishedNativeChatRestartRunShown(shown: ResumeRun): void {
    if (run === shown && !shown.inFlight && !shown.finishedViewShown) {
      setRun({ ...shown, finishedViewShown: true })
    }
  }

  function releaseFinishedNativeChatRestartRun(): void {
    if (run?.finishedViewShown && !resumeRunInFlight(run)) {
      setRun(null)
    }
  }

  /**
   * Re-reads the host's answer.
   *
   * Called before the toast is reopened, so a count can never name a chat the host would now refuse.
   */
  async function readNativeChatRestartOffer(
    allowed = () => true,
    refreshAttribution = false
  ): Promise<HostOfferRead> {
    const issued = turn.begun()
    const settled = turn.settled()
    const reading = ++readSequence
    const mayPublish = () =>
      current() &&
      allowed() &&
      reading === readSequence &&
      issued === turn.begun() &&
      settled === turn.settled()
    if (!mayPublish()) {
      return { ...EMPTY, available: false }
    }
    const read = await readRestartHostOffer(target)
    if (!mayPublish()) {
      return { ...EMPTY, available: false }
    }
    if (!read.available) {
      return read
    }
    const ids = await readDesktopCreatedChatIds(target, read, createdHere, refreshAttribution)
    if (mayPublish()) {
      createdHere = ids
      publishAnswer({ candidates: read.candidates, failed: read.failed, listedAt: Date.now() })
    }
    return mayPublish() ? read : { ...EMPTY, available: false }
  }

  async function refreshNativeChatRestartOffer(): Promise<void> {
    await readNativeChatRestartOffer()
  }

  /** The status bar entry: re-read, then open only over rows, since the toast draws nothing without
   *  them. Opening a chat from it is read-only and keeps the offer. */
  async function reopenNativeChatRestartOffer(): Promise<void> {
    if (!current()) {
      return
    }
    // Mid-resume the host's answer is already on its way; a re-read racing it could undo it.
    if (resuming.length === 0) {
      await readNativeChatRestartOffer()
    }
    if (current() && (run !== null || offer.candidates.length > 0 || offer.failed.length > 0)) {
      requestNativeChatResumeOnRestartDialog()
    }
  }

  /** One host action owns the selection; its status feed reports each chat before the reply.
   *  `took`: the host's own launch action already took these chats; follow it and send nothing. */
  async function continueNativeChatRestartOffer(
    sessionIds: readonly string[],
    startedBy: ResumeRunStarter = 'user',
    took?: NativeChatRestartOffer['candidates']
  ): Promise<void> {
    const hostTook = took !== undefined
    // The host's own launch action already started its chats: it waits its turn, never drops.
    // Re-checked after each wait: another action may take the turn first. From here to begin()
    // nothing awaits, so the launch acquires the turn the moment it sees it free.
    while (hostTook && current() && !turn.idle()) {
      await turn.waitIdle(() => !current())
    }
    // Checked before any further await, so an activation while one is in flight sends nothing.
    const requested = hostTook ? [...new Set(sessionIds)] : unsentResumeIds(run, sessionIds)
    if (!current() || requested.length === 0 || !turn.idle()) {
      return
    }
    const issued = turn.begin()
    const actionCurrent = () => current() && turn.begun() === issued
    forgetUnsentResumes(requested)
    const rows = new Map([...offer.candidates, ...offer.failed].map((row) => [row.sessionId, row]))
    let actionRun = nextResumeRun(
      run,
      took ?? requested.flatMap((sessionId) => rows.get(sessionId) ?? []),
      Date.now(),
      startedBy
    )
    setRun(actionRun)
    releaseRunStatus?.()
    const release = watchResumeRunStatus(
      () => (actionCurrent() && run === actionRun ? actionRun : null),
      (next) => {
        actionRun = next
        setRun(next)
      },
      target
    )
    releaseRunStatus = release
    if (target.kind === 'local') {
      markNativeChatLaunchResumeDecided()
    }
    let outcomes = NO_RESTART_CONTINUATION
    try {
      outcomes = await continueRestartChunks(target, requested, {
        followHostLaunch: took !== undefined,
        current: actionCurrent,
        publish: (answer) => {
          if (actionCurrent()) {
            publishAnswer(answer)
          }
        },
        refresh: readNativeChatRestartOffer,
        failures: () => offer.failed,
        markUnsent: (ids, at) => {
          markUnsentResumes(ids, at)
          publishAnswer(offer)
        }
      })
    } finally {
      release()
      turn.end(current())
      if (current()) {
        if (releaseRunStatus === release) {
          releaseRunStatus = undefined
        }
        if (run === actionRun) {
          setRun(
            settledResumeRun(
              actionRun,
              new Set(outcomes.attempted),
              outcomes.skipped,
              outcomes.continued
            )
          )
        }
      }
    }
    // The toast reports the settled result, even after it was closed mid-run.
    if (actionCurrent()) {
      requestNativeChatResumeOnRestartDialog()
    }
  }

  /**
   * Turning the offer down for good, which explicitly deletes the pending durable records.
   *
   * A failed write or unreachable host leaves the durable record untouched. The re-read puts it back
   * in the status bar; if that read fails too, the entry stays hidden until the next launch reads it.
   */
  async function dismissNativeChatRestartOffer(sessionIds?: readonly string[]): Promise<void> {
    if (!current()) {
      return
    }
    if (target.kind !== 'local') {
      consumeNativeChatResumeOnRestartDialogRequest()
      releaseFinishedNativeChatRestartRun()
      return
    }
    // One action owns the occurrence; a dismissal racing a resume would discard its reply.
    if (!turn.idle()) {
      return
    }
    turn.begin()
    try {
      const result = await dismissRestartHostOffer(target, sessionIds)
      if (!current()) {
        return
      }
      // Only a dismissal the host took ends the mark; a failed one leaves the chat shown as failed.
      forgetUnsentResumes(sessionIds)
      if (result) {
        // A settled run's own outcomes would otherwise bring a dismissed refusal back as a row.
        if (run && !run.inFlight) {
          setRun(withoutResumeRunSessions(run, sessionIds))
        }
        publishAnswer(result)
      } else {
        await refreshNativeChatRestartOffer()
      }
    } catch {
      if (current()) {
        await refreshNativeChatRestartOffer()
      }
    } finally {
      turn.end(current())
    }
  }

  const discovery = createRemoteRestartOfferLifecycle({
    read: (allowed) => readNativeChatRestartOffer(allowed, true),
    requestDialog: () => {
      if (current()) {
        requestNativeChatResumeOnRestartDialog()
      }
    },
    currentAction: () => turn.begun()
  })
  function dispose(): void {
    live = false
    turn.wake()
    discovery.dispose()
    releaseRunStatus?.()
    offeredChatWatch.release()
    consumeNativeChatResumeOnRestartDialogRequest()
  }

  return {
    getNativeChatRestartOffer: (): NativeChatRestartOffer => offer,
    getNativeChatRestartResuming: (): readonly string[] => resuming,
    getNativeChatRestartRun: (): ResumeRun | null => run,
    markFinishedNativeChatRestartRunShown,
    releaseFinishedNativeChatRestartRun,
    refreshNativeChatRestartOffer,
    reopenNativeChatRestartOffer,
    continueNativeChatRestartOffer,
    dismissNativeChatRestartOffer,
    identity,
    dispose,
    startedHere: (id: string) => createdHere?.has(id) === true,
    observeRuntimeStatus: discovery.observeRuntimeStatus,
    readNativeChatRestartOffer
  }
}
