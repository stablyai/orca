import { describe, expect, it } from 'vitest'
import type { ExternalAutomationRun } from '../../../../shared/automations-types'
import {
  createExternalAutomationRunTableState,
  resolveExternalAutomationFetchedRuns,
  resolveExternalAutomationRunTableState,
  updateExternalAutomationRunTablePage
} from './external-automation-run-table-state'

function run(id: string): ExternalAutomationRun {
  return {
    id,
    managerId: 'manager-1',
    provider: 'hermes',
    jobId: 'job-1',
    runAt: '2026-05-31T10:00:00.000Z',
    status: 'completed',
    outputPreview: `run ${id}`,
    outputContent: null,
    error: null,
    outputPath: null
  }
}

function job(
  id: string,
  runs: readonly ExternalAutomationRun[]
): {
  id: string
  runs: readonly ExternalAutomationRun[]
} {
  return {
    id,
    runs
  }
}

describe('external automation run table state', () => {
  it('resets page, selection, fetched rows, and error when the job changes', () => {
    const current = {
      ...createExternalAutomationRunTableState(job('job-1', [run('run-1')])),
      page: 2,
      selectedRunId: 'run-9',
      fetchedRuns: [run('run-9')],
      fetchedTotalCount: 20,
      fetchError: 'Failed'
    }

    expect(resolveExternalAutomationRunTableState(current, job('job-2', [run('run-2')]))).toEqual({
      sourceJobId: 'job-2',
      sourceRuns: [run('run-2')],
      page: 0,
      selectedRunId: 'run-2',
      fetchedRuns: null,
      fetchedTotalCount: null,
      fetchError: null
    })
  })

  it('resets when the same job receives a new fallback run list', () => {
    const firstRuns = [run('run-1')]
    const nextRuns = [run('run-2')]
    const current = {
      ...createExternalAutomationRunTableState(job('job-1', firstRuns)),
      selectedRunId: 'run-1'
    }

    expect(resolveExternalAutomationRunTableState(current, job('job-1', nextRuns))).toMatchObject({
      sourceJobId: 'job-1',
      sourceRuns: nextRuns,
      page: 0,
      selectedRunId: 'run-2',
      fetchedRuns: null
    })
  })

  it('preserves selected fetched runs when loading another page response for the same job', () => {
    const current = {
      ...createExternalAutomationRunTableState(job('job-1', [run('fallback')])),
      selectedRunId: 'run-2'
    }

    expect(
      resolveExternalAutomationFetchedRuns(current, job('job-1', current.sourceRuns), {
        runs: [run('run-1'), run('run-2')],
        totalCount: 12
      })
    ).toMatchObject({
      selectedRunId: 'run-2',
      fetchedRuns: [run('run-1'), run('run-2')],
      fetchedTotalCount: 12
    })
  })

  it('clears selection when paging manually', () => {
    const current = {
      ...createExternalAutomationRunTableState(job('job-1', [run('run-1')])),
      selectedRunId: 'run-1'
    }

    expect(
      updateExternalAutomationRunTablePage(current, job('job-1', current.sourceRuns), 3)
    ).toMatchObject({
      page: 3,
      selectedRunId: null
    })
  })
})
