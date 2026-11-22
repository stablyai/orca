import { useTranslate } from '@/i18n/use-translate'
import { lazy, Suspense, useCallback, useContext, useMemo, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { WorkerDockResult } from '../../../../../../shared/orchestration/dock/worker-dock'
import { useNativeChatPinnedWorkerApprovals } from '../../worker-approvals/native-chat-worker-approval-feed'
import { useWorkerDockFeed } from './dock/worker-dock-feed'
import type { WorkerDockRowView } from './dock/WorkerDockRow'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { openOrchestrationCrewAgent } from '@/lib/agent-session/open/open-agent-message-sender'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { useWorkerDockRosterState } from './dock/NativeChatWorkerDockFrame'
import { Button } from '@/components/ui/button'
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

const WorkerDockResultDialog = lazy(() =>
  import('./dock/WorkerDockResultDialog').then((module) => ({
    default: module.WorkerDockResultDialog
  }))
)
const WorkerDockProviderDetailsDialog = lazy(() =>
  import('./dock/WorkerDockProviderDetailsDialog').then((module) => ({
    default: module.WorkerDockProviderDetailsDialog
  }))
)

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
  const t = useTranslate()
  const [expanded, setExpanded] = useState<{ sessionId: string; expanded: boolean } | null>(null)
  const childRowContext = useStructuredSessionChildRowContext(
    props.paneKey,
    props.isVisible && props.backgroundTasks.show && Boolean(props.backgroundTasks.children?.length)
  )
  const { backgroundTasks, stop } = props

  const roster = useWorkerDockRosterState()
  const target = props.target ?? LOCAL
  const ownerActionsAvailable = target.kind === 'local'
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
  const workerRows = useMemo(
    () =>
      new Map(
        [...feed.rows].map(([id, row]) => {
          const settled =
            row.state === 'failed' || row.state === 'unexpected' || row.state === 'saving'
          const prompt = settled ? undefined : openApprovals.get(row.dispatchId)
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
    [feed.rows, feed.available, openApprovals]
  )
  const workerIdentities = useMemo(
    () =>
      feed.snapshot?.identities.map((row) => {
        const settled =
          row.state === 'failed' || row.state === 'unexpected' || row.state === 'saving'
        const prompt = settled ? undefined : openApprovals.get(row.dispatchId)
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
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WorkerDockResult | null>(null)
  const [opened, setOpened] = useState<{ row: WorkerDockRowView; opener: HTMLElement } | null>(null)
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
  const open = useCallback(
    (row: WorkerDockRowView, opener: HTMLElement) => {
      if (!feed.party) {
        return
      }
      if (!row.resultId && !row.settlement && !row.retired) {
        workerOpen(row)
        return
      }
      setOpened({ row, opener })
      void callRuntimeRpc(target, 'orchestration.workerDockResult', {
        party: feed.party,
        dispatch: row.dispatchId
      }).then(
        (value) => {
          const parsed = WorkerDockResult.safeParse(value)
          if (parsed.success) {
            setResult(parsed.data)
          } else {
            setError(row.reason ?? 'The saved result is not available yet. Try again.')
          }
        },
        (value) => setError(value instanceof Error ? value.message : String(value))
      )
    },
    [feed.party, target, workerOpen]
  )
  const acknowledge = useCallback(
    async (settlements: { dispatchId: string; settlement: string }[], acknowledged = true) => {
      if (!feed.party) {
        return
      }
      for (let offset = 0; offset < settlements.length; offset += 1000) {
        await callRuntimeRpc(target, 'orchestration.workerDockAcknowledge', {
          party: feed.party,
          settlements: settlements.slice(offset, offset + 1000),
          acknowledged
        })
      }
    },
    [feed.party, target]
  )
  const action = useCallback(
    (row: WorkerDockRowView, kind: 'stop' | 'clear') => {
      if (!feed.party) {
        return
      }
      const requestId = createNonSecureContextUuid()
      const attempt = () => {
        setPending((current) => new Set(current).add(row.id))
        setError(null)
        const request =
          kind === 'clear' && row.settlement
            ? acknowledge([{ dispatchId: row.dispatchId, settlement: row.settlement }])
            : callRuntimeRpc(target, 'orchestration.workerDockStop', {
                party: feed.party,
                dispatch: row.dispatchId,
                requestId
              })
        void request
          .catch((value) => {
            setRetryAction(() => attempt)
            setError(value instanceof Error ? value.message : String(value))
          })
          .finally(() =>
            setPending((current) => {
              const next = new Set(current)
              next.delete(row.id)
              return next
            })
          )
      }
      attempt()
    },
    [acknowledge, feed.party, target]
  )
  const clearAll = () => {
    const captured = (feed.snapshot?.identities ?? []).flatMap((row) =>
      row.settlement && (row.state === 'failed' || row.state === 'unexpected')
        ? [{ dispatchId: row.dispatchId, settlement: row.settlement }]
        : []
    )
    const capturedDispatches = new Set(captured.map((item) => item.dispatchId))
    const capturedIds = new Set(
      (feed.snapshot?.identities ?? [])
        .filter((row) => capturedDispatches.has(row.dispatchId))
        .map((row) => row.id)
    )
    const attempt = () => {
      setError(null)
      setPending((current) => new Set([...current, ...capturedIds]))
      void acknowledge(captured)
        .catch((value) => {
          setRetryAction(() => attempt)
          setError(value instanceof Error ? value.message : String(value))
        })
        .finally(() =>
          setPending((current) => new Set([...current].filter((id) => !capturedIds.has(id))))
        )
    }
    attempt()
  }
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
    <>
      <NativeChatBackgroundTasksStatus
        isVisible={props.isVisible}
        sessionId={props.sessionId}
        workerRows={controlledWorkerRows}
        ownerActionsAvailable={ownerActionsAvailable}
        workerIdentities={controlledWorkerIdentities}
        onOpenWorker={open}
        onWorkerAction={action}
        onClearAll={clearAll}
        loadWindow={feed.loadWindow}
        tasks={backgroundTasks.tasks}
        settledTasks={backgroundTasks.settledTasks}
        {...(backgroundTasks.children
          ? { childViews: backgroundTasks.children, childRowContext }
          : {})}
        indicatorActive={backgroundTasks.isMonitoring}
        supportsTaskStop={backgroundTasks.supportsStop}
        offersStopAll={backgroundTasks.offersStopAll}
        incomplete={backgroundTasks.incomplete || !feed.available}
        stoppingTaskIds={new Set([...stop.stoppingTaskIds, ...pending])}
        stoppingAll={stop.stoppingAll}
        expanded={expandedHere}
        onExpandedChange={(value) => {
          setExpanded({ sessionId: props.sessionId, expanded: value })
          roster.setExpanded(value)
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
      {error && !opened ? (
        <div role="alert" className="px-4 py-1 text-xs text-muted-foreground">
          {error}
          {retryAction ? (
            <Button variant="ghost" size="xs" onClick={() => retryAction?.()}>
              {t('components.native-chat.workerDock.retry', 'Retry')}
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={() => setError(null)}>
            {t('components.native-chat.workerDock.dismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
      {opened ? (
        <Suspense fallback={null}>
          <WorkerDockResultDialog
            ownerActionsAvailable={ownerActionsAvailable && result?.ownerActionsAvailable !== false}
            result={result}
            error={opened ? error : null}
            onClose={() => {
              setResult(null)
              setError(null)
              const opener = opened?.opener
              setOpened(null)
              if (opener?.isConnected) {
                opener.focus()
              } else {
                document
                  .querySelector<HTMLButtonElement>(
                    '[data-native-chat-background-tasks] button[aria-expanded]'
                  )
                  ?.focus()
              }
            }}
            onOpen={() => {
              if (opened) {
                workerOpen(opened.row)
              }
            }}
            onRestore={() => {
              if (result) {
                void acknowledge(
                  [{ dispatchId: result.dispatchId, settlement: result.settlement }],
                  false
                ).then(
                  () => setResult({ ...result, acknowledged: false }),
                  (value) => setError(value instanceof Error ? value.message : String(value))
                )
              }
            }}
          />
        </Suspense>
      ) : null}
    </>
  )
}

const LOCAL: RuntimeClientTarget = { kind: 'local' }
