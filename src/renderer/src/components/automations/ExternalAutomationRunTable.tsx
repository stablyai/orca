import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, FileText, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type {
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun
} from '../../../../shared/automations-types'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'

const PAGE_SIZE = 8

export type ExternalAutomationRunPage = {
  runs: ExternalAutomationRun[]
  totalCount?: number
}

export type FetchExternalAutomationRuns = (input: {
  manager: ExternalAutomationManager
  job: ExternalAutomationJob
  page: number
  pageSize: number
}) => Promise<ExternalAutomationRun[] | ExternalAutomationRunPage>

type ExternalAutomationRunTableProps = {
  manager: ExternalAutomationManager
  job: ExternalAutomationJob
  now: number
  onFetchRuns?: FetchExternalAutomationRuns
  onOpenRun?: (run: ExternalAutomationRun) => void
}

function formatExternalDate(value: string | null, now: number): string {
  if (!value) {
    return 'Never'
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return value
  }
  return formatAutomationDateTimeWithRelative(parsed, now)
}

function getRunStatusLabel(run: ExternalAutomationRun): string {
  switch (run.status) {
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'unknown':
      return 'Unknown'
  }
}

function getRunStatusVariant(
  run: ExternalAutomationRun
): React.ComponentProps<typeof Badge>['variant'] {
  switch (run.status) {
    case 'completed':
      return 'secondary'
    case 'failed':
      return 'destructive'
    case 'unknown':
      return 'outline'
  }
}

function getRunSummary(run: ExternalAutomationRun): string {
  return run.error ?? run.outputPreview ?? 'No output preview'
}

function normalizeRunPage(
  result: ExternalAutomationRun[] | ExternalAutomationRunPage
): ExternalAutomationRunPage {
  if (Array.isArray(result)) {
    return { runs: result }
  }
  return result
}

export function ExternalAutomationRunTable({
  manager,
  job,
  now,
  onFetchRuns,
  onOpenRun
}: ExternalAutomationRunTableProps): React.JSX.Element {
  const [page, setPage] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(job.runs[0]?.id ?? null)
  const [fetchedRuns, setFetchedRuns] = useState<ExternalAutomationRun[] | null>(null)
  const [fetchedTotalCount, setFetchedTotalCount] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const managerRef = useRef(manager)
  const jobRef = useRef(job)

  managerRef.current = manager
  jobRef.current = job

  useEffect(() => {
    setPage(0)
    setSelectedRunId(job.runs[0]?.id ?? null)
    setFetchedRuns(null)
    setFetchedTotalCount(null)
    setFetchError(null)
  }, [job.id, job.runs])

  useEffect(() => {
    if (!onFetchRuns) {
      return
    }
    let cancelled = false
    setIsLoading(true)
    setFetchError(null)
    void onFetchRuns({
      manager: managerRef.current,
      job: jobRef.current,
      page,
      pageSize: PAGE_SIZE
    })
      .then((result) => {
        if (cancelled) {
          return
        }
        const nextPage = normalizeRunPage(result)
        setFetchedRuns(nextPage.runs)
        setFetchedTotalCount(nextPage.totalCount ?? null)
        setSelectedRunId((current) => {
          if (current && nextPage.runs.some((run) => run.id === current)) {
            return current
          }
          return nextPage.runs[0]?.id ?? null
        })
      })
      .catch((error) => {
        if (!cancelled) {
          setFetchedRuns(null)
          setFetchedTotalCount(null)
          setFetchError(error instanceof Error ? error.message : 'Failed to load runs.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [job.id, manager.id, onFetchRuns, page])

  const fallbackRuns = job.runs
  const visibleRuns = onFetchRuns
    ? (fetchedRuns ?? fallbackRuns.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE))
    : fallbackRuns.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
  const totalCount = onFetchRuns ? (fetchedTotalCount ?? job.runCount) : job.runCount
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const selectedRun = useMemo(
    () =>
      visibleRuns.find((run) => run.id === selectedRunId) ??
      fallbackRuns.find((run) => run.id === selectedRunId) ??
      visibleRuns[0] ??
      null,
    [fallbackRuns, selectedRunId, visibleRuns]
  )
  const hasVisibleRuns = visibleRuns.length > 0
  const pageStart = totalCount === 0 || !hasVisibleRuns ? 0 : page * PAGE_SIZE + 1
  const pageEnd = Math.min(totalCount, page * PAGE_SIZE + visibleRuns.length)

  const handlePageChange = (nextPage: number): void => {
    setPage(nextPage)
    setSelectedRunId(null)
  }

  return (
    <div className="mt-2 rounded-md border border-border/50 bg-background/50">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-xs font-medium">Runs</div>
          {isLoading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          {fetchError ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertCircle className="size-3.5 text-destructive" />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {fetchError}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {totalCount} {totalCount === 1 ? 'run' : 'runs'}
        </div>
      </div>

      {hasVisibleRuns ? (
        <div>
          <div className="min-w-0 border-b border-border/50">
            <div className="grid grid-cols-[minmax(7.5rem,.45fr)_minmax(0,1fr)_auto] gap-3 border-b border-border/50 px-3 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <span>Run time</span>
              <span>Preview</span>
              <span>Status</span>
            </div>
            <div className="divide-y divide-border/50">
              {visibleRuns.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  data-current={selectedRun?.id === run.id}
                  onClick={() => {
                    setSelectedRunId(run.id)
                    onOpenRun?.(run)
                  }}
                  className={cn(
                    'grid w-full grid-cols-[minmax(7.5rem,.45fr)_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    selectedRun?.id === run.id && 'bg-accent text-accent-foreground'
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs">
                      {formatExternalDate(run.runAt, now)}
                    </span>
                    {run.outputPath ? (
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                        {run.outputPath}
                      </span>
                    ) : null}
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {getRunSummary(run)}
                  </span>
                  <Badge variant={getRunStatusVariant(run)}>{getRunStatusLabel(run)}</Badge>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="px-3 py-4 text-sm text-muted-foreground">
          {isLoading ? 'Loading runs...' : 'No Hermes runs found yet.'}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <FileText className="size-3.5" />
          <span>
            {pageStart}-{pageEnd} of {totalCount}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous run page"
            disabled={page === 0 || isLoading}
            onClick={() => handlePageChange(Math.max(0, page - 1))}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <div className="min-w-14 text-center text-xs text-muted-foreground">
            {page + 1} / {totalPages}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next run page"
            disabled={page >= totalPages - 1 || isLoading}
            onClick={() => handlePageChange(Math.min(totalPages - 1, page + 1))}
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
