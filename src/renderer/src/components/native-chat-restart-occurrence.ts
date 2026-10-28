import {
  EMPTY,
  dismissRestartHostOffer,
  readRestartHostOffer,
  restartOfferOnTarget,
  type NativeChatRestartOffer,
  type HostOfferRead
} from './native-chat-restart-host-offer'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { markNativeChatLaunchResumeDecided } from './native-chat-launch-resume-decision'
import { announceRestartResults } from './native-chat-restart-action-notifications'
import {
  beginResumeRun,
  resumeRunInFlight,
  resumeRunPendingIds,
  type ResumeRun,
  type ResumeRunStarter
} from './native-chat-resume-run'
import { createUnsentResumes } from './native-chat-resume-unsent-requests'
import * as dialog from './native-chat-resume-on-restart-dialog'
import { createOfferedChatWatch } from './native-chat-resume-offered-chat-watch'
import {
  createRemoteRestartOfferLifecycle,
  readDesktopCreatedChatIds
} from './native-chat-remote-restart-offer'
import {
  continueRestartChunks,
  type RestartContinuationBatchResult
} from './native-chat-restart-continuation-chunks'
import { watchResumeRunStatus } from './native-chat-resume-run-status-watch'

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
  let actionsBegun = 0
  let actionsSettled = 0
  let readSequence = 0
  /** Memory-only history: retires after viewing and closing its finished summary, or on replacement. */
  let run: ResumeRun | null = null
  let releaseRunStatus: (() => void) | undefined
  let resuming: readonly string[] = resumeRunPendingIds(null)

  function emit(): void {
    for (const listener of listeners) {
      listener()
    }
  }

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
      if (current() && actionsBegun === actionsSettled) {
        const issued = actionsBegun
        void readNativeChatRestartOffer(() => actionsBegun === issued)
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
   * Called before the dialog is reopened, so a count can never name a chat the host would now refuse.
   */
  async function readNativeChatRestartOffer(
    allowed = () => true,
    refreshAttribution = false
  ): Promise<HostOfferRead> {
    const issued = actionsBegun
    const settled = actionsSettled
    const reading = ++readSequence
    const mayPublish = () =>
      current() &&
      allowed() &&
      reading === readSequence &&
      issued === actionsBegun &&
      settled === actionsSettled
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

  /** The status bar entry and the toast's action: re-read, then open only over rows, since the dialog
   *  draws nothing without them. Opening a chat from it is read-only and keeps the offer. */
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

  /** One host action owns the selection; its status feed reports each chat before the reply. */
  async function continueNativeChatRestartOffer(
    sessionIds: readonly string[],
    startedBy: ResumeRunStarter = 'user'
  ): Promise<void> {
    const requested = [...new Set(sessionIds)]
    if (!current() || requested.length === 0) {
      return
    }
    const issued = ++actionsBegun
    const actionCurrent = () => current() && actionsBegun === issued
    forgetUnsentResumes(requested)
    const rows = new Map([...offer.candidates, ...offer.failed].map((row) => [row.sessionId, row]))
    let actionRun = beginResumeRun(
      requested.flatMap((sessionId) => rows.get(sessionId) ?? []),
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
    let outcomes: RestartContinuationBatchResult = {
      attempted: [],
      continued: [],
      skipped: new Set()
    }
    try {
      outcomes = await continueRestartChunks(target, requested, {
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
      if (current()) {
        if (releaseRunStatus === release) {
          releaseRunStatus = undefined
        }
        actionsSettled += 1
        const attemptedIds = new Set(outcomes.attempted)
        if (run === actionRun) {
          setRun({
            ...actionRun,
            entries: actionRun.entries.filter(
              (entry) =>
                attemptedIds.has(entry.candidate.sessionId) &&
                !outcomes.skipped.has(entry.candidate.sessionId)
            ),
            inFlight: false,
            continued: outcomes.continued
          })
        }
      }
    }
    if (actionCurrent()) {
      announceRestartResults(
        outcomes.attempted.filter((id) => !outcomes.skipped.has(id)),
        outcomes.continued,
        outcomes.failed,
        reopenNativeChatRestartOffer
      )
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
    actionsBegun += 1
    try {
      const result = await dismissRestartHostOffer(target, sessionIds)
      if (!current()) {
        return
      }
      // Only a dismissal the host took ends the mark; a failed one leaves the chat shown as failed.
      forgetUnsentResumes(sessionIds)
      if (result) {
        publishAnswer(result)
      } else {
        await refreshNativeChatRestartOffer()
      }
    } catch {
      if (current()) {
        await refreshNativeChatRestartOffer()
      }
    } finally {
      if (current()) {
        actionsSettled += 1
      }
    }
  }

  const discovery = createRemoteRestartOfferLifecycle({
    read: (allowed) => readNativeChatRestartOffer(allowed, true),
    requestDialog: () => {
      if (current()) {
        requestNativeChatResumeOnRestartDialog()
      }
    },
    currentAction: () => actionsBegun
  })
  function dispose(): void {
    live = false
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
