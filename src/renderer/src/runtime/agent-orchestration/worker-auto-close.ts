import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { selectVisibleAgentOrchestration } from '@/runtime/agent-orchestration/visible-agent-orchestration'
import { selectWorktreeAgentOrchestration } from '@/components/sidebar/workspace-card/activity/worktree-agent-orchestration-index'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { toHostSessionPaneKey } from '../../../../shared/workspace-layout/terminal-surface-id'
import { ORCHESTRATION_WORKER_KEEP_OPEN_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import {
  pollWorkerAutoClose,
  publishWorkerAutoClose,
  readPublishedWorkerAutoClose,
  readWorkerAutoCloseReply,
  subscribeWorkerAutoClose,
  type WorkerAutoCloseState
} from '../../../../shared/orchestration/workers/worker-auto-close'

/** A terminal pane, or a chat named by session: its owning host resolves the pane credential. */
export type WorkerAutoCloseSubject = { paneKey: string } | { sessionId: string }

const RPC_OPTIONS = { suppressFeatureInteraction: true }

/** The subject as its host names it: a mirrored `web-terminal-` pane goes back to the host's own key. */
export function hostWorkerSubject(
  target: RuntimeClientTarget,
  subject: WorkerAutoCloseSubject
): WorkerAutoCloseSubject {
  return target.kind === 'environment' && 'paneKey' in subject
    ? { paneKey: toHostSessionPaneKey(subject.paneKey) }
    : subject
}

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
        ? callRuntimeRpc<unknown>(
            target,
            'orchestration.workerAutoClose',
            hostWorkerSubject(target, subject),
            RPC_OPTIONS
          )
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
    { ...hostWorkerSubject(target, subject), keep },
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
function workerActivity(state: AppState, paneKey: string, worktreeId?: string): string | null {
  const context = selectVisibleAgentOrchestration(state)[paneKey]
  if (context) {
    return dispatchActivity(state, paneKey, context)
  }
  if (!worktreeId) {
    return null
  }
  // Any other terminal where a worker runs may be bound to it (its setup or a startup tab); the host knows.
  const workers = Object.entries(selectWorktreeAgentOrchestration(state, worktreeId))
  return workers.length > 0
    ? workers
        .map(([workerPaneKey, worker]) => dispatchActivity(state, workerPaneKey, worker))
        .sort()
        .join('|')
    : null
}

function dispatchActivity(
  state: AppState,
  paneKey: string,
  context: AgentStatusOrchestrationContext
): string {
  return `${context.dispatchId}:${context.dispatchStatus ?? ''}:${state.agentStatusByPaneKey.get(paneKey)?.state ?? ''}`
}

/** The host's auto-close state for a shown pane this client knows is an orchestration worker, plus the
 *  clock its countdown ticks on. Read while `active`, again whenever its Dispatch or agent moves on.
 *  With `worktreeId`, a terminal that is no worker is asked too while a worker runs there. */
export function useWorkerAutoClose(
  target: RuntimeClientTarget,
  subject: WorkerAutoCloseSubject,
  paneKey: string,
  active: boolean,
  worktreeId?: string
): { state: WorkerAutoCloseState | null; nowMs: number; keepOpen: () => void } {
  const key = workerAutoCloseKey(target, subject)
  const subscribe = useCallback(
    (listener: () => void) => subscribeWorkerAutoClose(key, listener),
    [key]
  )
  const state = useSyncExternalStore(subscribe, () => readPublishedWorkerAutoClose(key))
  const activity = useAppStore((s) => workerActivity(s, paneKey, worktreeId))
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

export function workerKeepOpenLabel(t: Translate = translate): string {
  return t('components.orchestration.workerAutoClose.keepOpen', 'Keep open')
}
