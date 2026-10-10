import { useEffect } from 'react'
import { isRuntimeHostContactRevoked } from '../../../shared/runtime-host-status'
import { parseRestartOfferOrigin } from '../../../shared/restart-offer-origin'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  LOCAL_RESTART_MACHINE,
  restartMachineKey,
  restartMachineTarget,
  type RestartMachineKey
} from './native-chat-restart-machines'
import { restartMachineName } from './native-chat-restart-machine-name'
import { continueNativeChatRestartOffers } from './native-chat-restart-offer-actions'
import {
  _resetNativeChatRestartOfferState,
  forgetNativeChatRestartMachine,
  getNativeChatRestartOffers,
  readNativeChatRestartMachine,
  setNativeChatRestartReadListener,
  type RestartMachineRead
} from './native-chat-resume-on-restart-store'
import { requestLaunchResumePrompt } from './native-chat-resume-on-restart-launch-prompt'
import { markNativeChatLaunchResumeDecided } from './native-chat-launch-resume-decision'
import {
  _resetNativeChatResumeOnRestartDialog,
  nativeChatResumeDialogOnScreen
} from './native-chat-resume-on-restart-dialog'
import {
  _resetRestartDecidedMemory,
  decidedRestartInterruptions,
  forgetRestartInterruptions,
  restartDecidedEnvironments,
  restartInterruptionKey,
  settleRestartInterruptions
} from './native-chat-restart-decided'
import { announceReconnectRestartOffer } from './native-chat-restart-reconnect-toast'
import { reopenNativeChatRestartOffer } from './native-chat-restart-offer-reopen'

/**
 * When each machine is asked for its offer, and the one decision a fresh offer makes: ask, resume
 * the user's own chats without asking, or (for a paired server) say so in a toast.
 *
 * This computer is asked once, at launch. Each paired server is asked on every verified connection
 * — the first, a new runtime, and a return after lost contact — never from its chat status feed,
 * which needs a host that may not exist yet. A failed paired read is retried a few times while the
 * connection holds.
 *
 * The toast is decided from the answer, not from a remembered edge: any published read of a paired
 * server announces (or, opted in, resumes) the user's own interruptions this desktop has not yet
 * decided about, then records them as decided.
 */

const LAUNCH_READ_RETRY_DELAYS_MS = [100, 250, 500] as const
const PAIRED_READ_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const

let launch: Promise<void> | undefined

function autoResumeEnabled(): boolean {
  return useAppStore.getState().settings?.nativeChatResumeWorkOnRestart === true
}

/** The user's own chats among those the machine still offers right now. */
function ownCandidates(
  target: RuntimeClientTarget,
  read: readonly ResumeCandidate[]
): ResumeCandidate[] {
  const stillOffered = new Set(
    getNativeChatRestartOffers()
      .get(restartMachineKey(target))
      ?.candidates.map((candidate) => candidate.sessionId) ?? []
  )
  return read.filter(
    (candidate) =>
      stillOffered.has(candidate.sessionId) && parseRestartOfferOrigin(candidate.origin) === 'own'
  )
}

/** "Resume automatically": ends in the same one toast a clicked resume does. */
function resumeOwn(machine: RestartMachineKey, own: readonly ResumeCandidate[]): Promise<void> {
  return continueNativeChatRestartOffers([
    { machine, sessionIds: own.map((candidate) => candidate.sessionId) }
  ])
}

/**
 * This launch's single read of this computer's offer.
 *
 * Runs once however many surfaces mount, so the count and the dialog describe the same answer and
 * an opted-in launch cannot dispatch twice.
 */
async function loadLaunchOffer(): Promise<void> {
  // The preference belongs to this launch's request; later saves cannot dispatch another.
  const resumeWithoutAsking = autoResumeEnabled()
  const target: RuntimeClientTarget = { kind: 'local' }
  let read: RestartMachineRead = await readNativeChatRestartMachine(target)
  // Host startup can race the renderer. Retry only failed reads, never a confirmed empty result,
  // so a transient startup gap does not strand a durable offer or add steady-state polling.
  for (const delay of LAUNCH_READ_RETRY_DELAYS_MS) {
    if (read.kind !== 'unavailable') {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    read = await readNativeChatRestartMachine(target)
  }
  // Failures left from an earlier launch are the status bar's to show; only a fresh offer of the
  // user's own chats asks. Another device's or an automation's alone never open the dialog.
  const own = read.kind === 'answered' ? ownCandidates(target, read.candidates) : []
  if (own.length === 0) {
    return
  }
  if (!resumeWithoutAsking) {
    requestLaunchResumePrompt()
    return
  }
  // Not awaited: nothing will ask, so other launch prompts need not wait for the resume to settle.
  void resumeOwn(LOCAL_RESTART_MACHINE, own)
}

/**
 * A paired server's published answer: its own interruptions this desktop has not decided about
 * are resumed (opted in) or announced, and every key the server no longer offers is forgotten.
 * Shown in an open dialog, they are decided without a toast.
 */
function decidePairedAnswer(target: RuntimeClientTarget, candidates: readonly ResumeCandidate[]) {
  if (target.kind !== 'environment') {
    return
  }
  const machine = restartMachineKey(target)
  const decided = decidedRestartInterruptions(target.environmentId)
  const fresh = ownCandidates(target, candidates).filter(
    (candidate) => !decided.has(restartInterruptionKey(candidate))
  )
  settleRestartInterruptions(
    target.environmentId,
    candidates.map(restartInterruptionKey),
    fresh.map(restartInterruptionKey)
  )
  // A resume dialog on screen lists every machine: what it shows needs no toast.
  if (fresh.length === 0 || nativeChatResumeDialogOnScreen(getNativeChatRestartOffers().size > 0)) {
    return
  }
  if (autoResumeEnabled()) {
    void resumeOwn(machine, fresh)
    return
  }
  const fence = getNativeChatRestartOffers().get(machine)?.fence
  announceReconnectRestartOffer({
    machine,
    machineName: restartMachineName(machine),
    own: fresh,
    resume: (sessionIds) =>
      void continueNativeChatRestartOffers([{ machine, sessionIds }], { expected: fence }),
    show: () => void reopenNativeChatRestartOffer([machine])
  })
}

/** Marks what an open dialog shows as decided, so a later read does not announce it again. */
export function markNativeChatRestartOffersShown(
  shown: readonly { machine: RestartMachineKey; candidates: readonly ResumeCandidate[] }[]
): void {
  for (const { machine, candidates } of shown) {
    const target = restartMachineTarget(machine)
    if (target.kind === 'environment') {
      const keys = candidates.map(restartInterruptionKey)
      settleRestartInterruptions(target.environmentId, keys, keys)
    }
  }
}

type SeenConnection = { key: string; pairingRevision: number | undefined; generation: number }
const seenConnections = new Map<string, SeenConnection>()
/** Each paired server's pairing revision as the saved list last named it. */
const knownPairingRevisions = new Map<string, number>()
let stopWatchingConnections: (() => void) | null = null
let connectionGenerations = 0

function connectionStillCurrent(environmentId: string, generation: number): boolean {
  return seenConnections.get(environmentId)?.generation === generation
}

/** One verified connection: read, and retry a failed read a few times while it holds. */
async function readPairedMachineOnConnection(environmentId: string, generation: number) {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId }
  for (const delay of [...PAIRED_READ_RETRY_DELAYS_MS, null]) {
    const read = await readNativeChatRestartMachine(target)
    if (read.kind !== 'unavailable' || delay === null) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    if (!connectionStillCurrent(environmentId, generation)) {
      return
    }
  }
}

function forgetPairedMachine(environmentId: string): void {
  forgetNativeChatRestartMachine(restartMachineKey({ kind: 'environment', environmentId }))
  forgetRestartInterruptions(environmentId)
}

/**
 * Reads a paired server's offer on each verified connection transition. Loss of contact reads
 * nothing and keeps the offer; only a revoked pairing, a re-pair or a removed server forgets it.
 */
function noticeConnections(state: AppState): void {
  const paired = new Set(state.runtimeEnvironments.map((environment) => environment.id))
  for (const environmentId of paired) {
    // A re-pair is known from the saved record before the new pairing ever connects: the old
    // pairing's rows go now, not once the new one answers.
    const revision = getRuntimeEnvironmentRevision(environmentId)
    const known = knownPairingRevisions.get(environmentId)
    if (revision !== undefined) {
      if (known !== undefined && known !== revision) {
        forgetPairedMachine(environmentId)
      }
      knownPairingRevisions.set(environmentId, revision)
    }
  }
  for (const [environmentId, entry] of state.runtimeStatusByEnvironmentId) {
    if (!paired.has(environmentId)) {
      continue
    }
    const pairingRevision = entry.snapshot?.pairingRevision
    if (isRuntimeHostContactRevoked(entry)) {
      seenConnections.set(environmentId, { key: '', pairingRevision, generation: 0 })
      forgetPairedMachine(environmentId)
      continue
    }
    const runtimeId = entry.status?.runtimeId
    if (!runtimeId) {
      continue
    }
    const key = `${pairingRevision ?? ''}\u0000${runtimeId}\u0000${entry.hostContactEpoch ?? 0}`
    const seen = seenConnections.get(environmentId)
    if (seen?.key === key) {
      continue
    }
    if (seen && seen.pairingRevision !== pairingRevision) {
      // Re-paired under the same id: the old pairing's offers, ticks and decisions are not this one's.
      forgetPairedMachine(environmentId)
    }
    const generation = ++connectionGenerations
    seenConnections.set(environmentId, { key, pairingRevision, generation })
    void readPairedMachineOnConnection(environmentId, generation)
  }
  // Until the saved server list has loaded, a missing server is not a removed one.
  if (!state.runtimeEnvironmentCatalogHydrated) {
    return
  }
  const removed = new Set(
    [
      ...[...getNativeChatRestartOffers().keys()].flatMap((machine) => {
        const target = restartMachineTarget(machine)
        return target.kind === 'environment' ? [target.environmentId] : []
      }),
      ...seenConnections.keys(),
      ...restartDecidedEnvironments()
    ].filter((environmentId) => !paired.has(environmentId))
  )
  for (const environmentId of removed) {
    seenConnections.delete(environmentId)
    knownPairingRevisions.delete(environmentId)
    forgetPairedMachine(environmentId)
  }
}

function watchPairedConnections(): void {
  // A browser client has no paired servers of its own to ask.
  if (stopWatchingConnections || isWebClientLocation()) {
    return
  }
  setNativeChatRestartReadListener(decidePairedAnswer)
  let last: AppState | null = null
  const check = (state: AppState): void => {
    if (
      last &&
      last.runtimeStatusByEnvironmentId === state.runtimeStatusByEnvironmentId &&
      last.runtimeEnvironments === state.runtimeEnvironments
    ) {
      return
    }
    last = state
    noticeConnections(state)
  }
  stopWatchingConnections = useAppStore.subscribe(check)
  check(useAppStore.getState())
}

/**
 * Starts every source of restart offers. `localEnabled` gates only this computer's launch read:
 * settings arrive after the first render, so the read waits for the flag rather than being lost.
 */
export function useNativeChatRestartOfferSources(localEnabled: boolean): void {
  useEffect(watchPairedConnections, [])
  useEffect(() => {
    if (localEnabled) {
      // Fetched after mount, never awaited by startup: the workspace is usable first. Decided
      // either way, so in-chat Continue stops waiting on this computer's chats.
      launch ??= loadLaunchOffer().finally(markNativeChatLaunchResumeDecided)
    }
  }, [localEnabled])
}

/** @internal - tests need a clean module between cases: every offer, action and trigger. */
export function _resetNativeChatRestartOffer(): void {
  _resetNativeChatRestartOfferState()
  _resetNativeChatResumeOnRestartDialog()
  _resetRestartDecidedMemory()
  launch = undefined
  seenConnections.clear()
  knownPairingRevisions.clear()
  connectionGenerations = 0
  stopWatchingConnections?.()
  stopWatchingConnections = null
}
