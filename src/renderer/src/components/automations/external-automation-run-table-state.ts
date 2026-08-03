import type { ExternalAutomationRun } from '../../../../shared/automations-types'

type ExternalAutomationRunTableJob = {
  id: string
  runs: readonly ExternalAutomationRun[]
}

type ExternalAutomationRunPageResult = {
  runs: ExternalAutomationRun[]
  totalCount?: number
}

export type ExternalAutomationRunTableState = {
  sourceJobId: string
  sourceRuns: readonly ExternalAutomationRun[]
  page: number
  selectedRunId: string | null
  fetchedRuns: ExternalAutomationRun[] | null
  fetchedTotalCount: number | null
  fetchError: string | null
}

export function createExternalAutomationRunTableState(
  job: ExternalAutomationRunTableJob
): ExternalAutomationRunTableState {
  return {
    sourceJobId: job.id,
    sourceRuns: job.runs,
    page: 0,
    selectedRunId: job.runs[0]?.id ?? null,
    fetchedRuns: null,
    fetchedTotalCount: null,
    fetchError: null
  }
}

export function resolveExternalAutomationRunTableState(
  state: ExternalAutomationRunTableState,
  job: ExternalAutomationRunTableJob
): ExternalAutomationRunTableState {
  return state.sourceJobId === job.id && state.sourceRuns === job.runs
    ? state
    : createExternalAutomationRunTableState(job)
}

export function updateExternalAutomationRunTablePage(
  state: ExternalAutomationRunTableState,
  job: ExternalAutomationRunTableJob,
  page: number
): ExternalAutomationRunTableState {
  return {
    ...resolveExternalAutomationRunTableState(state, job),
    page,
    selectedRunId: null
  }
}

export function resolveExternalAutomationFetchedRuns(
  state: ExternalAutomationRunTableState,
  job: ExternalAutomationRunTableJob,
  result: ExternalAutomationRunPageResult
): ExternalAutomationRunTableState {
  const resolved = resolveExternalAutomationRunTableState(state, job)
  const selectedRunId =
    resolved.selectedRunId && result.runs.some((run) => run.id === resolved.selectedRunId)
      ? resolved.selectedRunId
      : (result.runs[0]?.id ?? null)

  return {
    ...resolved,
    fetchedRuns: result.runs,
    fetchedTotalCount: result.totalCount ?? null,
    selectedRunId
  }
}
