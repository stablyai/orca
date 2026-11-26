import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useNativeChatPinnedWorkerApprovals } from '../../worker-approvals/native-chat-worker-approval-feed'
import { useWorkerDockFeed } from './dock/worker-dock-feed'
import type { WorkerDockRowView } from './dock/WorkerDockRow'
import type { WorkerDockSnapshot } from '../../../../../../shared/orchestration/dock/worker-dock'
import { openOrchestrationCrewAgent } from '@/lib/agent-session/open/open-agent-message-sender'
import { useWorkerDockOwnerActions } from './dock/use-worker-dock-owner-actions'
import { WorkerDockFeedLossesContext, workerDockStopBlock } from './dock/worker-dock-stop-check'
import {
  useWorkerDockFailureFocusHandoff,
  WorkerDockFailureStrip
} from './dock/WorkerDockFailureStrip'
import { WorkerDockResultDialogSlot } from './dock/WorkerDockResultDialogSlot'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import {
  ORCHESTRATION_PAIRED_WORKER_DOCK_OWNER_RUNTIME_CAPABILITY,
  ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { pairedHostClientCapabilities } from '@/runtime/rpc/targets/paired-host-client-capabilities'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'
import { NativeChatCrewBackgroundTasksStatus } from './NativeChatCrewBackgroundTasksStatus'
import type { StructuredSessionBackgroundTasksView } from '../../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import { useStructuredSessionChildRowContext } from './use-structured-session-child-row-context'
import type { StructuredSessionTaskStop } from './use-structured-session-task-stop'
import { openNativeChatSubagent } from '../../subagents/native-chat-open-subagent'
import {
  NativeChatCrewContext,
  useNativeChatCrew
} from '../../../orchestration-crew/use-native-chat-crew'

const WorkerDockProviderDetailsDialog = lazy(() =>
  import('./dock/WorkerDockProviderDetailsDialog').then((module) => ({
    default: module.WorkerDockProviderDetailsDialog
  }))
)

/** An exited worker whose dispatch is still open is not settled: with the feed away it has no Stop. */
function workerDockRowSettled(row: { state: string; settlement: string | null }): boolean {
  return (
    row.state === 'failed' ||
    row.state === 'saving' ||
    (row.state === 'unexpected' && Boolean(row.settlement))
  )
}

export function NativeChatStructuredSessionStatus(props: {
  sessionId: string
  target?: RuntimeClientTarget
  /** The session's own status row, whose verdict the strip's children read; also names the pane a picked agent opens in. */
  paneKey: string
  isVisible: boolean
  /** The session's background work. */
  backgroundTasks: StructuredSessionBackgroundTasksView
  stop: StructuredSessionTaskStop
  /** The agent whose view the pane shows, marked current in the strip. */
  currentAgentId?: string | null
}): React.JSX.Element {
  // The chat's crew, when it has one: the strip then shows even with no background work.
  const crew = useNativeChatCrew(useContext(NativeChatCrewContext))
  const [expanded, setExpanded] = useState<{ sessionId: string; expanded: boolean } | null>(null)
  const childRowContext = useStructuredSessionChildRowContext(
    props.paneKey,
    props.isVisible && props.backgroundTasks.show && Boolean(props.backgroundTasks.children?.length)
  )
  const { backgroundTasks, stop } = props

  const target = props.target ?? LOCAL
  // A paired host takes Clear and Stop from a client it counts as a person once it says it does; an
  // older host or another client is refused, so its rows keep pointing to the computer they run on.
  const pairedOwnerActions = useRuntimeEnvironmentCapability(
    target.kind === 'environment' && pairedHostCountsThisClientAsPerson()
      ? target.environmentId
      : null,
    ORCHESTRATION_PAIRED_WORKER_DOCK_OWNER_RUNTIME_CAPABILITY
  )
  const ownerActionsAvailable = target.kind === 'local' || pairedOwnerActions
  const expandedHere = expanded?.sessionId === props.sessionId && expanded.expanded
  const feed = useWorkerDockFeed(
    target,
    props.sessionId,
    props.isVisible,
    backgroundTasks.workerDock,
    expandedHere
  )
  const approvals = useNativeChatPinnedWorkerApprovals(target, feed.party)
  const openApprovals = useMemo(
    () =>
      new Map(
        approvals
          .filter((entry) => entry.approval.state === 'open')
          .map((entry) => [entry.approval.worker.dispatchId, entry])
      ),
    [approvals]
  )
  const identityById = useMemo(
    () => new Map((feed.snapshot?.identities ?? []).map((row) => [row.id, row])),
    [feed.snapshot?.identities]
  )
  const workerRows = useMemo(
    () =>
      new Map(
        [...feed.rows].map(([id, detail]) => {
          const row = withCurrentLifecycle(detail, identityById.get(id))
          const settled = workerDockRowSettled(row)
          const prompt = approvalLabels(row, settled)
            ? openApprovals.get(row.dispatchId)
            : undefined
          return [
            id,
            !feed.available && !settled
              ? { ...row, state: 'unavailable' as const, changedAt: null, stoppable: false }
              : prompt
                ? {
                    ...row,
                    state: 'needs-you' as const,
                    changedAt: Date.parse(prompt.askedAt ?? prompt.at),
                    question: prompt.approval.summary.title
                  }
                : row
          ]
        })
      ),
    [feed.rows, identityById, feed.available, openApprovals]
  )
  const workerIdentities = useMemo(
    () =>
      feed.snapshot?.identities.map((row) => {
        const settled = workerDockRowSettled(row)
        const prompt = approvalLabels(row, settled) ? openApprovals.get(row.dispatchId) : undefined
        return !feed.available && !settled
          ? { ...row, state: 'unavailable' as const, changedAt: null }
          : prompt
            ? {
                ...row,
                state: 'needs-you' as const,
                changedAt: Date.parse(prompt.askedAt ?? prompt.at)
              }
            : row
      }),
    [feed.snapshot?.identities, feed.available, openApprovals]
  )
  const controlledWorkerRows = useMemo(
    () =>
      new Map(
        [...workerRows].map(([id, row]) => [
          id,
          { ...row, ownerActionsAvailable: ownerActionsAvailable && row.ownerActionsAvailable }
        ])
      ),
    [workerRows, ownerActionsAvailable]
  )
  const controlledWorkerIdentities = useMemo(
    () =>
      workerIdentities?.map((row) => ({
        ...row,
        ownerActionsAvailable: ownerActionsAvailable && row.ownerActionsAvailable
      })),
    [workerIdentities, ownerActionsAvailable]
  )
  const [providerDetails, setProviderDetails] = useState<{
    row: WorkerDockRowView
    opener: HTMLElement
  } | null>(null)
  const workerOpen = useCallback(
    (row: WorkerDockRowView) =>
      void openOrchestrationCrewAgent(
        {
          partyKey: row.id,
          role: 'worker',
          label: row.name,
          agentKind: 'unknown',
          status: row.state,
          openTarget: { kind: 'dispatch', address: `dispatch:${row.dispatchId}` }
        },
        target
      ),
    [target]
  )
  // Read live when a Stop or its Retry is sent, never from rows a held press kept on screen.
  const stopBlock = useLatestHandler((row: WorkerDockRowView, party: string) =>
    workerDockStopBlock(row, party, {
      party: feed.party,
      available: feed.available,
      rows: controlledWorkerRows,
      identities: controlledWorkerIdentities
    })
  )
  // A focused Retry or Dismiss leaves with the failure line; focus then moves to the next line or
  // the dock's toggle instead of the page.
  const failureFocus = useWorkerDockFailureFocusHandoff()
  const owner = useWorkerDockOwnerActions(
    target,
    feed.party,
    controlledWorkerIdentities,
    workerOpen,
    stopBlock
  )
  const { dialog, failure } = owner
  // An attempt that ends with no failure line (it succeeded, or was dismissed) hands focus to no
  // line: a later, unrelated failure must not take it.
  const attemptOpen = Boolean(failure) || owner.pending.size > 0
  useEffect(() => {
    if (!attemptOpen) {
      failureFocus.release()
    }
  }, [attemptOpen, failureFocus])
  if (crew) {
    // The suspended crew panel's strip keeps main's own view while it is enabled.
    return (
      <NativeChatCrewBackgroundTasksStatus
        isVisible={props.isVisible}
        tasks={backgroundTasks.tasks}
        settledTasks={backgroundTasks.settledTasks}
        {...(backgroundTasks.children
          ? { childViews: backgroundTasks.children, childRowContext }
          : {})}
        indicatorActive={backgroundTasks.isMonitoring}
        supportsTaskStop={backgroundTasks.supportsStop}
        offersStopAll={backgroundTasks.offersStopAll}
        incomplete={backgroundTasks.incomplete}
        stoppingTaskIds={stop.stoppingTaskIds}
        stoppingAll={stop.stoppingAll}
        expanded={expandedHere}
        onExpandedChange={(value) => setExpanded({ sessionId: props.sessionId, expanded: value })}
        onStop={stop.onStop}
        currentAgentId={props.currentAgentId ?? null}
        onShowAgent={(providerId) => openNativeChatSubagent(props.paneKey, providerId)}
        crew={crew}
      />
    )
  }
  return (
    <WorkerDockFeedLossesContext.Provider value={feed.readLosses}>
      <NativeChatBackgroundTasksStatus
        isVisible={props.isVisible}
        sessionId={props.sessionId}
        workerRows={controlledWorkerRows}
        workerIdentities={controlledWorkerIdentities}
        onOpenWorker={owner.open}
        onWorkerAction={owner.action}
        onClearAll={owner.clearAll}
        loadWindow={feed.loadWindow}
        incomplete={backgroundTasks.incomplete}
        unavailable={!feed.available}
        tasks={backgroundTasks.tasks}
        settledTasks={backgroundTasks.settledTasks}
        {...(backgroundTasks.children
          ? { childViews: backgroundTasks.children, childRowContext }
          : {})}
        indicatorActive={backgroundTasks.isMonitoring}
        supportsTaskStop={backgroundTasks.supportsStop}
        offersStopAll={backgroundTasks.offersStopAll}
        stoppingTaskIds={new Set([...stop.stoppingTaskIds, ...owner.pending])}
        stoppingAll={stop.stoppingAll}
        expanded={expandedHere}
        onExpandedChange={(value) => {
          setExpanded({ sessionId: props.sessionId, expanded: value })
        }}
        onStop={stop.onStop}
        currentAgentId={props.currentAgentId ?? null}
        onShowAgent={(providerId) => openNativeChatSubagent(props.paneKey, providerId)}
        onShowProviderDetails={(row, opener) => setProviderDetails({ row, opener })}
      />
      {providerDetails ? (
        <Suspense fallback={null}>
          <WorkerDockProviderDetailsDialog
            row={providerDetails.row}
            opener={providerDetails.opener}
            sessionId={props.sessionId}
            target={target}
            onClose={() => setProviderDetails(null)}
          />
        </Suspense>
      ) : null}
      {failure && !dialog ? (
        <WorkerDockFailureStrip
          key={`${failure.message}\0${failure.retry ? 'retry' : 'final'}`}
          failure={failure}
          onDismiss={owner.dismissFailure}
          focusHandoff={failureFocus}
        />
      ) : null}
      <WorkerDockResultDialogSlot
        dialog={dialog}
        hostId={getRuntimeTargetHostId(target)}
        ownerActionsAvailable={ownerActionsAvailable}
        onClose={owner.close}
        onOpen={workerOpen}
        onRestore={owner.restore}
      />
    </WorkerDockFeedLossesContext.Provider>
  )
}

const LOCAL: RuntimeClientTarget = { kind: 'local' }

/** The host's owner check passes a paired client only when its handshake says it is a person's. */
function pairedHostCountsThisClientAsPerson(): boolean {
  return pairedHostClientCapabilities().includes(ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY)
}

/** The identity is the current lifecycle; a cached detail can lag it (a metadata-only update
 *  moves the identity alone). The row shows, and Stop is checked against, the identity's state. */
function withCurrentLifecycle(
  detail: WorkerDockRowView,
  current: WorkerDockSnapshot['identities'][number] | undefined
): WorkerDockRowView {
  if (
    !current ||
    current.dispatchId !== detail.dispatchId ||
    (current.state === detail.state &&
      current.settlement === detail.settlement &&
      current.changedAt === detail.changedAt &&
      current.ownerActionsAvailable === detail.ownerActionsAvailable)
  ) {
    return detail
  }
  return {
    ...detail,
    state: current.state,
    changedAt: current.changedAt,
    settlement: current.settlement,
    ownerActionsAvailable: current.ownerActionsAvailable
  }
}

/** An open approval labels a worker as waiting on you only while it is unsettled and not already
 *  stopping, so the label never hides that state or re-enables its Stop. */
function approvalLabels(row: { state: WorkerDockRowView['state'] }, settled: boolean): boolean {
  return !settled && row.state !== 'stopping'
}
