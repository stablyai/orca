import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ArrowRight } from 'lucide-react'
import { PipelineStatusBadge } from './PipelineStatusBadge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { PipelineV2OwnerRequestSummary } from '../../../../shared/pipelines/v2/pipeline-v2-public-results'
import { callPipelineRpc } from './pipeline-api'
import {
  readPipelineOwnerProposal,
  confirmPipelineOwnerProposal,
  readPipelineOwnerProposalDetails,
  runPipelineOwnerProposalAction,
  type PipelineOwnerProposalRead,
  type PipelineOwnerProposalDetails
} from './pipeline-owner-proposals'
import { PipelineOwnerRequestDetails } from './PipelineOwnerRequestDetails'

type Props = { projectId: string; runId?: string; onResolved?: () => void }
export function PipelineOwnerRequests(props: Props) {
  return <ProjectPipelineOwnerRequests key={`${props.projectId}:${props.runId ?? ''}`} {...props} />
}
function ProjectPipelineOwnerRequests({ projectId, runId, onResolved }: Props) {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [page, setPage] = useState<{
    requests: PipelineV2OwnerRequestSummary[]
    cursor: number
    hasMore: boolean
  }>()
  const [selected, setSelected] = useState<PipelineOwnerProposalRead>()
  const [detail, setDetail] = useState<PipelineOwnerProposalDetails>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('pending')
  useEffect(() => {
    let cancelled = false
    void callPipelineRpc<{
      requests: PipelineV2OwnerRequestSummary[]
      cursor: number
      hasMore: boolean
    }>('pipeline.v2.requests', { projectId, limit: 10 })
      .then((value) => {
        if (!cancelled) {
          setPage(value)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setError(String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectId])
  const load = async (cursor = 0) => {
    await runPipelineOwnerProposalAction(
      async () => {
        setPage(await callPipelineRpc('pipeline.v2.requests', { projectId, cursor, limit: 10 }))
      },
      setBusy,
      setError
    )
  }
  const inspect = async (kind: PipelineV2OwnerRequestSummary['kind'], requestId: string) => {
    setDetail(undefined)
    await runPipelineOwnerProposalAction(
      async () => {
        const shown = await readPipelineOwnerProposal(projectId, kind, requestId)
        setSelected(shown)
        if (shown.request) {
          setDetail(await readPipelineOwnerProposalDetails(shown))
        }
      },
      setBusy,
      setError
    )
  }
  const confirm = async () => {
    if (!selected) {
      return
    }
    await runPipelineOwnerProposalAction(
      async () => {
        const receipt = await confirmPipelineOwnerProposal(selected)
        setSelected({ ...selected, receipt })
        setPage(
          (page) =>
            page && {
              ...page,
              requests: page.requests.map((row) =>
                row.requestId === receipt.requestId ? { ...row, state: 'resolved' } : row
              )
            }
        )
        onResolved?.()
      },
      setBusy,
      setError
    )
  }
  const labels = {
    decision: t('pipelines.requestDecision', 'Stage decision'),
    budget: t('pipelines.requestBudget', 'Increase limits'),
    publish: t('pipelines.requestPublish', 'Publish template'),
    disable: t('pipelines.requestAvailability', 'Change version availability')
  }
  const request = selected?.request
  const template = detail?.template
  const needsPreview = request?.kind !== 'budget'
  const rows =
    page?.requests.filter((row) => (!runId || row.runId === runId) && row.state === filter) ?? []
  const title = (row: PipelineV2OwnerRequestSummary) =>
    row.action === 'accept'
      ? t('pipelines.acceptResultRequest', 'Accept a stage result')
      : row.action === 'rework'
        ? t('pipelines.reworkRequest', 'Return a stage for changes')
        : row.action === 'enable'
          ? t('pipelines.enableVersionRequest', 'Enable a template version')
          : row.action === 'disable'
            ? t('pipelines.disableVersionRequest', 'Disable a template version')
            : labels[row.kind]
  return (
    <section className="space-y-4">
      <h3 className="text-base font-semibold">{t('pipelines.decisionsInbox', 'Your decisions')}</h3>
      <p className="text-sm text-muted-foreground">
        {t(
          'pipelines.ownerRequestsMeaning',
          'Review what is proposed, what confirmation changes, and the recorded result.'
        )}
      </p>
      <div
        role="group"
        aria-label={t('pipelines.requestFilter', 'Request filter')}
        className="flex flex-wrap gap-1"
      >
        <Button
          variant={filter === 'pending' ? 'secondary' : 'ghost'}
          aria-pressed={filter === 'pending'}
          onClick={() => setFilter('pending')}
        >
          {t('pipelines.awaitingDecision', 'Awaiting decision')}
        </Button>
        <Button
          variant={filter === 'resolved' ? 'secondary' : 'ghost'}
          aria-pressed={filter === 'resolved'}
          onClick={() => setFilter('resolved')}
        >
          {t('pipelines.decisionHistory', 'Decision history')}
        </Button>
      </div>
      {page && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {page.hasMore || page.cursor > 10
            ? t(
                'pipelines.noRequestsOnPage',
                'No matching requests on this page. Browse other pages or refresh from the beginning.'
              )
            : filter === 'pending'
              ? t('pipelines.noPendingDecisions', 'No requests awaiting your decision.')
              : t('pipelines.noDecisionHistory', 'No confirmed decisions yet.')}
        </p>
      )}
      {rows.map((row) => (
        <Button
          key={row.requestId}
          variant="outline"
          className="h-auto w-full min-w-0 justify-start text-left"
          disabled={busy}
          onClick={() => void inspect(row.kind, row.requestId)}
        >
          <span className="min-w-0 flex-1 whitespace-normal">
            <span className="block font-medium">{title(row)}</span>
            {row.subject && <span className="mt-1 block text-sm">{row.subject}</span>}
            <span className="mt-1 block text-xs text-muted-foreground">
              {new Date(row.createdAt).toLocaleString(locale)}
            </span>
          </span>
          <PipelineStatusBadge
            state={row.state === 'resolved' ? 'completed' : 'waiting_owner'}
            label={
              row.state === 'resolved'
                ? t('pipelines.requestResolved', 'Confirmed')
                : t('pipelines.awaitingDecision', 'Awaiting decision')
            }
          />
          <ArrowRight className="size-4 shrink-0" />
        </Button>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void load()}>
          {t('pipelines.refreshRequests', 'Refresh requests')}
        </Button>
        {page?.hasMore && (
          <Button variant="outline" disabled={busy} onClick={() => void load(page.cursor)}>
            {t('pipelines.nextRequests', 'Next requests')}
          </Button>
        )}
      </div>
      {error && !selected && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {busy && !selected && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('pipelines.requestInProgress', 'Processing the request…')}
        </p>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setSelected(undefined)
          }
        }}
      >
        <DialogContent surface="security" className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {request ? labels[request.kind] : t('pipelines.ownerRequest', 'Owner request')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'pipelines.confirmOriginalRequest',
                'Review the proposed action and its result. Only explicit confirmation applies a pending request.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto scrollbar-sleek">
            {selected && <PipelineOwnerRequestDetails selected={selected} detail={detail} />}
            {request && (
              <details>
                <summary className="cursor-pointer text-xs">
                  {t('pipelines.requestParameters', 'Original request parameters')}
                </summary>
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(request.input, null, 2)}
                </pre>
              </details>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('pipelines.requestInProgress', 'Processing the request…')}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setSelected(undefined)}>
              {t('pipelines.close', 'Close')}
            </Button>
            {request && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void inspect(request.kind, request.requestId)}
              >
                {t('pipelines.checkActionResult', 'Check action result')}
              </Button>
            )}
            <Button
              disabled={
                busy ||
                !request ||
                Boolean(selected?.receipt) ||
                Boolean(error) ||
                (needsPreview && !template) ||
                detail?.availability !== 'current' ||
                selected?.runtimeId !== request?.input.expectedRuntimeId
              }
              onClick={() => void confirm()}
            >
              {t('pipelines.confirmProposedAction', 'Confirm this action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
