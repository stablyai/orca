import { useTranslate } from '@/i18n/use-translate'
import { workerDockResultLabel } from './worker-dock-result-label'
import { useMemo, useState } from 'react'
import { ChevronRight, CircleCheck, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { NativeChatMarkdown } from '../../../markdown/NativeChatMarkdown'
import { NativeChatCopyButton } from '../../../messages/actions/NativeChatCopyButton'
import type { NativeChatTimedRow } from '../../../conversation/slots/native-chat-timed-rows'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  WorkerDockResult,
  WorkerDockResultRef,
  oldestWorkerDockResultRef
} from '../../../../../../../shared/orchestration/dock/worker-dock'
import { useWorkerDockResults } from './worker-dock-feed'
import { openOrchestrationCrewAgent } from '@/lib/agent-session/open/open-agent-message-sender'
import { NativeChatWorkerApprovalTimeline } from '../../../worker-approvals/NativeChatWorkerApprovals'
import type { WorkerDockPresence } from '../../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'

export function NativeChatWorkerTimeline({
  approvalParty,
  children,
  ...source
}: Omit<Parameters<typeof NativeChatWorkerResultTimeline>[0], 'children'> & {
  approvalParty: string | null
  children: (rows: readonly NativeChatTimedRow[]) => React.ReactNode
}) {
  if (!source.workerDock) {
    return (
      <NativeChatWorkerApprovalTimeline party={approvalParty} target={source.target}>
        {children}
      </NativeChatWorkerApprovalTimeline>
    )
  }
  return (
    <NativeChatWorkerApprovalTimeline party={approvalParty} target={source.target}>
      {(approvalRows) => (
        <NativeChatWorkerResultTimeline {...source}>
          {(resultRows) => children([...approvalRows, ...resultRows])}
        </NativeChatWorkerResultTimeline>
      )}
    </NativeChatWorkerApprovalTimeline>
  )
}

function WorkerResult({
  reference,
  target,
  party
}: {
  reference: WorkerDockResultRef
  target: RuntimeClientTarget
  party: string
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<WorkerDockResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setOpen(true)
    void callRuntimeRpc(target, 'orchestration.workerDockResult', {
      party,
      dispatch: reference.dispatchId
    }).then(
      (value) => {
        const parsed = WorkerDockResult.safeParse(value)
        if (parsed.success) {
          setResult(parsed.data)
          setError(null)
        } else {
          setError('The saved result is unavailable. Try again.')
        }
      },
      (error) => setError(error instanceof Error ? error.message : String(error))
    )
  }
  const Icon =
    reference.outcome === 'failed' || reference.outcome === 'unexpected' ? CircleAlert : CircleCheck
  return (
    <div className="px-3 py-1 sm:px-4" data-native-chat-worker-result={reference.id}>
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-8 w-full items-center gap-2 rounded-md text-left text-xs text-chat-foreground-faint hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => {
          if (open) {
            setOpen(false)
          } else {
            load()
          }
        }}
      >
        <Icon aria-hidden="true" className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">
          {result
            ? `${result.name} · ${workerDockResultLabel(t, result.outcome)} · ${result.title}`
            : `${reference.name} · ${workerDockResultLabel(t, reference.outcome)} · ${reference.summary || reference.title}`}
        </span>
        <ChevronRight aria-hidden="true" className={open ? 'size-3 rotate-90' : 'size-3'} />
      </button>
      {open ? (
        <div className="pl-5 text-sm text-chat-foreground">
          {result ? (
            <>
              <NativeChatMarkdown content={result.body} linkifyFilePaths />
              <div className="flex items-center gap-2">
                <NativeChatCopyButton text={result.body} />
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    void openOrchestrationCrewAgent(
                      {
                        partyKey: reference.id,
                        role: 'worker',
                        label: result.name,
                        agentKind: 'unknown',
                        status: 'finished',
                        openTarget: {
                          kind: 'dispatch',
                          address: `dispatch:${reference.dispatchId}`
                        }
                      },
                      target
                    )
                  }
                >
                  {t('components.native-chat.workerDock.openWorker', 'Open worker')}
                </Button>
                {result.acknowledged ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={target.kind !== 'local' || !result.ownerActionsAvailable}
                    title={
                      target.kind !== 'local' || !result.ownerActionsAvailable
                        ? t(
                            'components.native-chat.workerDock.remoteOwner',
                            'Stop or clear this from the computer it runs on'
                          )
                        : undefined
                    }
                    onClick={() =>
                      void callRuntimeRpc(target, 'orchestration.workerDockAcknowledge', {
                        party,
                        acknowledged: false,
                        settlements: [
                          { dispatchId: result.dispatchId, settlement: result.settlement }
                        ]
                      }).then(
                        () => setResult({ ...result, acknowledged: false }),
                        (error) => setError(error instanceof Error ? error.message : String(error))
                      )
                    }
                  >
                    {t('components.native-chat.workerDock.restore', 'Show in dock again')}
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <p>
              {error ?? t('components.native-chat.workerDock.loadingResult', 'Loading result…')}
            </p>
          )}
          {error ? <p role="alert">{error}</p> : null}
          {error ? (
            <Button variant="ghost" size="xs" onClick={load}>
              {t('components.native-chat.workerDock.retry', 'Retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function NativeChatWorkerResultTimeline({
  target,
  sessionId,
  isVisible,
  workerDock,
  children
}: {
  target: RuntimeClientTarget
  sessionId: string
  isVisible: boolean
  workerDock?: WorkerDockPresence
  children: (rows: readonly NativeChatTimedRow[]) => React.ReactNode
}) {
  const t = useTranslate()
  const feed = useWorkerDockResults(target, sessionId, isVisible, workerDock)
  const [older, setOlder] = useState<readonly WorkerDockResultRef[]>([])
  const refs = useMemo(
    () => [...new Map([...(feed.results ?? []), ...older].map((ref) => [ref.id, ref])).values()],
    [feed.results, older]
  )
  const rows = useMemo(
    () =>
      refs.map((ref) => ({
        key: `worker-result:${ref.id}`,
        at: ref.at ?? 0,
        node: <WorkerResult reference={ref} target={target} party={feed.party ?? ''} />
      })),
    [refs, target, feed.party]
  )
  const loadOlder = () => {
    const before = oldestWorkerDockResultRef(refs)
    if (!before || !feed.party) {
      return
    }
    void callRuntimeRpc<unknown[]>(target, 'orchestration.workerDockResultsRead', {
      party: feed.party,
      before
    }).then((values) =>
      setOlder((current) => [
        ...current,
        ...values.map((value) => WorkerDockResultRef.parse(value))
      ])
    )
  }
  return children(
    refs.length >= 50
      ? [
          {
            key: 'worker-results-older',
            at: Math.min(...refs.map((ref) => ref.at ?? 0)) - 1,
            node: (
              <div className="px-3 sm:px-4">
                <Button variant="ghost" size="xs" onClick={loadOlder}>
                  {t('components.native-chat.workerDock.olderResults', 'Older worker results')}
                </Button>
              </div>
            )
          },
          ...rows
        ]
      : rows
  )
}
