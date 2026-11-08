import { defineFixture } from '../../component-fixtures/component-fixture'
import type { RunEvent } from '../../../../shared/orchestration-run-events'
import { RunHistoryTimeline } from './RunHistoryTimeline'

const run = { id: 'run_login', objective: 'Add a login page', created_at: '2026-10-28T10:00:00Z' }
const events: RunEvent[] = [
  {
    sequence: 1,
    runId: run.id,
    kind: 'run.created',
    entityId: run.id,
    taskId: null,
    dispatchId: null,
    recordedAt: '2026-10-28T10:00:00Z',
    data: { coordinator: 'term_coordinator', generation: 1 }
  },
  {
    sequence: 2,
    runId: run.id,
    kind: 'task.created',
    entityId: 'task_server',
    taskId: 'task_server',
    dispatchId: null,
    recordedAt: '2026-10-28T10:01:00Z',
    data: { title: 'Build the authentication endpoint', status: 'ready' }
  },
  {
    sequence: 3,
    runId: run.id,
    kind: 'dispatch.status_changed',
    entityId: 'ctx_server',
    taskId: 'task_server',
    dispatchId: 'ctx_server',
    recordedAt: '2026-10-28T10:04:00Z',
    data: { assignee: 'term_server', previousStatus: 'dispatched', status: 'failed' }
  },
  {
    sequence: 4,
    runId: run.id,
    kind: 'gate.created',
    entityId: 'gate_authentication',
    taskId: 'task_server',
    dispatchId: null,
    recordedAt: '2026-10-28T10:05:00Z',
    data: { status: 'pending' }
  }
]
const actions = {
  onBack: () => {},
  onRefresh: () => {},
  onRetry: () => {},
  onLoadMore: () => {},
  onOpenAgent: () => {}
}

export const recorded = defineFixture({
  width: 640,
  render: () => (
    <div className="flex h-[720px] flex-col bg-background text-foreground">
      <RunHistoryTimeline
        run={run}
        {...actions}
        page={{
          rows: events,
          nextCursor: null,
          coverage: { completeFromCreation: true, recordedSince: run.created_at },
          loading: false,
          loadingVisible: false,
          error: null
        }}
      />
    </div>
  )
})

export const partial = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-[680px] flex-col bg-background text-foreground">
      <RunHistoryTimeline
        run={run}
        {...actions}
        page={{
          rows: events.slice(1),
          nextCursor: 'next',
          coverage: { completeFromCreation: false, recordedSince: '2026-10-28T10:01:00Z' },
          loading: false,
          loadingVisible: false,
          error: null
        }}
      />
    </div>
  )
})

export const olderHost = defineFixture({
  width: 420,
  render: () => (
    <div className="flex h-[440px] flex-col bg-background text-foreground">
      <RunHistoryTimeline
        run={run}
        {...actions}
        page={{
          rows: [],
          nextCursor: null,
          loading: false,
          loadingVisible: false,
          error: 'unsupported'
        }}
      />
    </div>
  )
})

export const longHistory = defineFixture({
  width: 640,
  render: () => (
    <div className="flex h-[720px] flex-col bg-background text-foreground">
      <RunHistoryTimeline
        run={run}
        {...actions}
        page={{
          rows: Array.from({ length: 250 }, (_, index): RunEvent => ({
            sequence: index + 1,
            runId: run.id,
            kind: 'task.created',
            entityId: `task_${index}`,
            taskId: `task_${index}`,
            dispatchId: null,
            recordedAt: run.created_at,
            data: { title: `Implementation task ${index + 1}`, status: 'ready' }
          })),
          nextCursor: null,
          coverage: { completeFromCreation: true, recordedSince: run.created_at },
          loading: false,
          loadingVisible: false,
          error: null
        }}
      />
    </div>
  )
})

export const longHistoryScrolled = defineFixture({
  ...longHistory,
  interact: (frame) => {
    const scroller = frame.querySelector<HTMLElement>('.scrollbar-sleek')
    if (scroller) {
      scroller.scrollTop = 6500
      scroller.dispatchEvent(new Event('scroll'))
    }
  }
})
