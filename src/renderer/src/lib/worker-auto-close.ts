import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from '@/runtime/local-runtime-capabilities'
import { selectVisibleAgentOrchestration } from '@/runtime/visible-agent-orchestration'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { ORCHESTRATION_WORKER_KEEP_OPEN_RUNTIME_CAPABILITY } from '../../../shared/orchestration-runtime-capabilities'
import {
  formatWorkerAutoCloseCountdown,
  pollWorkerAutoClose,
  publishWorkerAutoClose,
  readPublishedWorkerAutoClose,
  readWorkerAutoCloseReply,
  subscribeWorkerAutoClose,
  type WorkerAutoCloseState
} from '../../../shared/worker-auto-close'

/** A terminal pane, or a chat named by session: its owning host resolves the pane credential. */
export type WorkerAutoCloseSubject = { paneKey: string } | { sessionId: string }

const RPC_OPTIONS = { suppressFeatureInteraction: true }

// An older host lacks the methods; asking its advertised capabilities first costs it no request.
async function hostKeepsWorkersOpen(target: RuntimeClientTarget): Promise<boolean> {
  if (target.kind === 'environment') {
    return runtimeEnvironmentSupportsCapability(
      target.environmentId,
      ORCHESTRATION_WORKER_KEEP_OPEN_RUNTIME_CAPABILITY
    )
  }
  await ensureLocalRuntimeCapabilities()
  return (
    readLocalRuntimeCapabilitiesOrUnknown()?.includes(
      ORCHESTRATION_WORKER_KEEP_OPEN_RUNTIME_CAPABILITY
    ) === true
  )
}

export function readWorkerAutoClose(
  target: RuntimeClientTarget,
  subject: WorkerAutoCloseSubject
): Promise<WorkerAutoCloseState | null> {
  return hostKeepsWorkersOpen(target)
    .then((supported) =>
      supported
        ? callRuntimeRpc<unknown>(target, 'orchestration.workerAutoClose', subject, RPC_OPTIONS)
        : null
    )
    .then(readWorkerAutoCloseReply)
    .catch(() => null)
}

export function setWorkerKeptOpen(
  target: RuntimeClientTarget,
  subject: WorkerAutoCloseSubject,
  keep: boolean
): Promise<WorkerAutoCloseState | null> {
  const key = workerAutoCloseKey(target, subject)
  return callRuntimeRpc<unknown>(
    target,
    'orchestration.workerKeepOpen',
    { ...subject, keep },
    RPC_OPTIONS
  )
    .then(readWorkerAutoCloseReply)
    .then((state) => {
      publishWorkerAutoClose(key, state)
      return state
    })
}

export function workerAutoCloseKey(
  target: RuntimeClientTarget,
  subject: WorkerAutoCloseSubject
): string {
  return JSON.stringify([target, subject])
}

// Changes when the pane's Dispatch or agent moves on, so the host is asked right then; null for non-workers.
function workerActivity(state: AppState, paneKey: string): string | null {
  const context = selectVisibleAgentOrchestration(state)[paneKey]
  return context
    ? `${context.dispatchId}:${context.dispatchStatus ?? ''}:${state.agentStatusByPaneKey[paneKey]?.state ?? ''}`
    : null
}

/** The host's auto-close state for a shown pane this client knows is an orchestration worker, plus the
 *  clock its countdown ticks on. Read while `active`, again whenever its Dispatch or agent moves on. */
export function useWorkerAutoClose(
  target: RuntimeClientTarget,
  subject: WorkerAutoCloseSubject,
  paneKey: string,
  active: boolean
): { state: WorkerAutoCloseState | null; nowMs: number; keepOpen: () => void } {
  const key = workerAutoCloseKey(target, subject)
  const subscribe = useCallback(
    (listener: () => void) => subscribeWorkerAutoClose(key, listener),
    [key]
  )
  const state = useSyncExternalStore(subscribe, () => readPublishedWorkerAutoClose(key))
  const activity = useAppStore((s) => workerActivity(s, paneKey))
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (activity === null) {
      // No longer a worker here: drop what it last said so nothing keeps ticking on it.
      publishWorkerAutoClose(key, null)
      return
    }
    if (!active) {
      return
    }
    return pollWorkerAutoClose(
      () => readWorkerAutoClose(target, subject),
      (next) => publishWorkerAutoClose(key, next)
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- key covers target and subject by value.
  }, [key, active, activity])

  const shown = activity === null ? null : state
  const ticking = active && shown !== null && !shown.kept && shown.closesAt !== null
  useEffect(() => {
    if (!ticking) {
      return
    }
    setNowMs(Date.now())
    const interval = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [ticking])

  const keepOpen = useCallback(() => {
    publishWorkerAutoClose(key, { kept: true })
    void setWorkerKeptOpen(target, subject, true).catch(() =>
      readWorkerAutoClose(target, subject).then((next) => publishWorkerAutoClose(key, next))
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- key covers target and subject by value.
  }, [key])

  return { state: shown, nowMs, keepOpen }
}

/** The strip's line; null when no strip shows (kept open, or nothing closes the worker). */
export function workerAutoCloseStripText(
  state: WorkerAutoCloseState | null,
  nowMs: number
): string | null {
  if (!state || state.kept) {
    return null
  }
  return state.closesAt === null
    ? translate(
        'components.orchestration.workerAutoClose.running',
        'Temporary orchestration worker · Closes 2 minutes after it finishes'
      )
    : translate(
        'components.orchestration.workerAutoClose.finished',
        'Temporary orchestration worker finished · Closes in {{countdown}}',
        { countdown: formatWorkerAutoCloseCountdown(state.closesAt, nowMs) }
      )
}

export function workerKeepOpenLabel(): string {
  return translate('components.orchestration.workerAutoClose.keepOpen', 'Keep open')
}
