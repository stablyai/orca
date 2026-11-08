import { defineFixture } from '../../component-fixtures/component-fixture'
import { RunHistoryBrowser } from './RunHistoryBrowser'
import type { RunEventsPage } from '../../../../shared/orchestration-run-events'

const run = { id: 'run_login', objective: 'Add a login page', created_at: '2026-10-28T10:00:00Z' }
const page: RunEventsPage = {
  runId: run.id,
  coverage: { completeFromCreation: true, recordedSince: run.created_at },
  nextCursor: null,
  events: [
    {
      sequence: 1,
      runId: run.id,
      kind: 'task.created',
      entityId: 'task_login',
      taskId: 'task_login',
      dispatchId: null,
      recordedAt: run.created_at,
      data: { title: 'Build the login form', status: 'ready' }
    }
  ]
}

export const selectedRun = defineFixture({
  width: 760,
  store: { runtimeEnvironments: [], runtimeEnvironmentCatalogHydrated: true },
  setup: () => {
    window.api.runtime.call = async ({ method }) => ({
      id: 'fixture',
      ok: true,
      result: method === 'orchestration.runList' ? { runs: [run], nextCursor: null } : page,
      _meta: { runtimeId: 'fixture' }
    })
  },
  render: () => (
    <div className="h-[640px]">
      <RunHistoryBrowser onBack={() => {}} onClose={() => {}} onReveal={() => {}} />
    </div>
  ),
  interact: (frame) => {
    const runButton = [...frame.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(run.objective)
    )
    runButton?.click()
  }
})
