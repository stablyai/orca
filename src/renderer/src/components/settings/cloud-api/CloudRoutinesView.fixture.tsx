import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  CloudApiProject,
  Routine,
  RoutineRun,
  RoutineRunPage
} from '../../../../../shared/cloud-api/cloud-api-types'
import { CloudRoutinesView, type CloudRoutinesViewProps } from './CloudRoutinesView'
import type { LoadRoutineRuns } from './RoutineRunHistory'

const NOW = Date.UTC(2026, 10, 9, 15, 0)
const MIN = 60_000
const HOUR = 3_600_000

const PROJECTS: CloudApiProject[] = [
  { id: 'prj_api', name: 'acme/api', repo: { url: 'https://github.com/acme/api', ref: 'main' } },
  { id: 'prj_web', name: 'acme/web', repo: { url: 'https://github.com/acme/web', ref: null } }
]

const base = {
  createdBy: 'u_ada',
  createdAt: NOW - 20 * 24 * HOUR,
  updatedAt: NOW - 2 * HOUR,
  machineSize: 'standard',
  maxRuntimeMinutes: 30
}

const ROUTINES: Routine[] = [
  {
    ...base,
    id: 'rt_triage',
    name: 'Triage new issues',
    projectId: 'prj_api',
    repo: null,
    enabled: true,
    trigger: { kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'America/New_York' },
    agent: 'claude',
    prompt: 'Label and summarize every issue opened since yesterday.',
    postResults: 'comment',
    nextRunAt: NOW + 3 * HOUR,
    lastRun: { id: 'run_1', status: 'succeeded', finishedAt: NOW - 21 * HOUR }
  },
  {
    ...base,
    id: 'rt_review',
    name: 'Review PRs labeled orca',
    projectId: null,
    repo: { url: 'https://github.com/acme/web', ref: null },
    enabled: true,
    trigger: { kind: 'github', events: ['pull_request.labeled'], labels: ['orca'] },
    agent: 'codex',
    prompt: 'Review the pull request for bugs and missing tests.',
    postResults: 'comment',
    nextRunAt: null,
    lastRun: { id: 'run_2', status: 'running', finishedAt: null }
  },
  {
    ...base,
    id: 'rt_fix',
    name: 'Fix flaky test from CI',
    projectId: 'prj_api',
    repo: null,
    enabled: false,
    trigger: { kind: 'webhook', urlHint: '…/hooks/rt_fix/••••Qz8' },
    agent: 'claude',
    prompt: 'Reproduce the failing test from the payload and open a PR with a fix.',
    postResults: 'pr',
    nextRunAt: null,
    lastRun: { id: 'run_3', status: 'failed', finishedAt: NOW - 3 * 24 * HOUR }
  },
  {
    ...base,
    id: 'rt_weekly',
    name: 'Weekly dependency bump',
    projectId: 'prj_web',
    repo: null,
    enabled: true,
    trigger: { kind: 'schedule', cron: '30 6 * * 1', timezone: 'Europe/Berlin' },
    agent: 'claude',
    prompt: 'Update minor dependencies and open a PR if tests pass.',
    postResults: 'pr',
    nextRunAt: NOW + 2 * 24 * HOUR,
    lastRun: null
  }
]

const run = (partial: Partial<RoutineRun> & Pick<RoutineRun, 'id' | 'status'>): RoutineRun => ({
  routineId: 'rt_triage',
  trigger: 'schedule',
  triggerDetail: null,
  workspaceId: null,
  result: null,
  error: null,
  createdAt: NOW - HOUR,
  startedAt: NOW - HOUR,
  finishedAt: null,
  durationMs: null,
  ...partial
})

const RUNS: RoutineRunPage = {
  nextBefore: NOW - 5 * 24 * HOUR,
  runs: [
    run({
      id: 'r6',
      status: 'running',
      trigger: 'manual',
      startedAt: NOW - 2 * MIN,
      workspaceId: 'sbx_7Hq2Lm'
    }),
    run({
      id: 'r5',
      status: 'posting',
      trigger: 'github',
      triggerDetail: 'acme/web#482 labeled orca',
      startedAt: NOW - 9 * MIN,
      workspaceId: 'sbx_P0wQ1e'
    }),
    run({
      id: 'r4',
      status: 'succeeded',
      startedAt: NOW - 21 * HOUR,
      durationMs: 4 * MIN + 12_000,
      workspaceId: 'sbx_c8Rk2a',
      result: {
        summary: 'Labeled 6 issues, closed 2 duplicates and asked for repro steps on #311.',
        commentUrl: 'https://github.com/acme/api/issues/311#issuecomment-1'
      }
    }),
    run({
      id: 'r3',
      status: 'succeeded',
      trigger: 'webhook',
      triggerDetail: 'POST from ci.acme.dev',
      startedAt: NOW - 30 * HOUR,
      durationMs: 11 * MIN + 3_000,
      result: { prUrl: 'https://github.com/acme/api/pull/512' }
    }),
    run({
      id: 'r2',
      status: 'failed',
      startedAt: NOW - 45 * HOUR,
      durationMs: 38_000,
      error:
        'The agent could not clone acme/api: the Orca Cloud GitHub App is not installed on this repository.'
    }),
    run({ id: 'r1', status: 'timed_out', startedAt: NOW - 69 * HOUR, durationMs: 30 * MIN }),
    run({
      id: 'r0',
      status: 'cancelled',
      trigger: 'manual',
      startedAt: NOW - 70 * HOUR,
      durationMs: 15_000
    })
  ]
}

const loadRuns: LoadRoutineRuns = async () => ({ ok: true, data: RUNS })
const loadNoRuns: LoadRoutineRuns = async () => ({ ok: true, data: { runs: [], nextBefore: null } })
const loadRunsFailing: LoadRoutineRuns = async () => ({ ok: false, error: 'network' })

const props: CloudRoutinesViewProps = {
  routines: { status: 'ok', data: ROUTINES },
  projects: PROJECTS,
  installations: [{ installationId: '1', account: 'acme', accountType: 'Organization' }],
  now: NOW,
  fixtureNow: NOW,
  localTimezone: 'America/New_York',
  onRefresh: () => {},
  onCreate: async () => ({ ok: false, error: 'server' }),
  onUpdate: async () => ({ ok: false, error: 'server' }),
  onToggle: async () => null,
  onRunNow: async () => null,
  onDelete: async () => null,
  onRotateWebhook: async () => ({
    ok: true,
    data: { url: 'https://api.orca.dev/hooks/rt_fix/n3wS3cr3tQz8xK' }
  }),
  loadRuns,
  onOpenWorkspace: () => {}
}

export const list = defineFixture({ width: 820, render: () => <CloudRoutinesView {...props} /> })

export const empty = defineFixture({
  width: 820,
  render: () => <CloudRoutinesView {...props} routines={{ status: 'ok', data: [] }} />
})

export const loading = defineFixture({
  width: 820,
  render: () => <CloudRoutinesView {...props} routines={{ status: 'loading' }} />
})

export const error = defineFixture({
  width: 820,
  render: () => (
    <CloudRoutinesView
      {...props}
      routines={{
        status: 'error',
        code: 'network',
        message: 'Could not reach Orca Cloud. Check your connection and try again.'
      }}
    />
  )
})

export const notAvailable = defineFixture({
  width: 820,
  render: () => (
    <CloudRoutinesView
      {...props}
      routines={{ status: 'error', code: 'not-available', message: '' }}
    />
  )
})

export const runHistory = defineFixture({
  width: 820,
  render: () => <CloudRoutinesView {...props} initial={{ historyFor: 'rt_review' }} />
})

export const runHistoryEmpty = defineFixture({
  width: 820,
  render: () => (
    <CloudRoutinesView {...props} loadRuns={loadNoRuns} initial={{ historyFor: 'rt_weekly' }} />
  )
})

export const runHistoryError = defineFixture({
  width: 820,
  render: () => (
    <CloudRoutinesView {...props} loadRuns={loadRunsFailing} initial={{ historyFor: 'rt_fix' }} />
  )
})

export const editorSchedule = defineFixture({
  width: 820,
  render: () => <CloudRoutinesView {...props} initial={{ editor: { routineId: 'rt_triage' } }} />
})

export const editorCustomCron = defineFixture({
  width: 820,
  render: () => (
    <CloudRoutinesView
      {...props}
      initial={{
        editor: {
          routineId: null,
          draft: {
            name: 'Nightly smoke test',
            schedulePreset: 'custom',
            customCron: '15 2 * * *',
            prompt: 'Run the smoke suite.'
          }
        }
      }}
    />
  )
})

export const editorGithub = defineFixture({
  width: 820,
  render: () => <CloudRoutinesView {...props} initial={{ editor: { routineId: 'rt_review' } }} />
})

export const editorWebhook = defineFixture({
  width: 820,
  render: () => <CloudRoutinesView {...props} initial={{ editor: { routineId: 'rt_fix' } }} />
})

export const editorValidation = defineFixture({
  width: 820,
  render: () => (
    <CloudRoutinesView
      {...props}
      projects={[]}
      initial={{ editor: { routineId: null, draft: { repoUrl: 'github.com/acme' } } }}
    />
  ),
  interact: async () => {
    document
      .querySelector<HTMLButtonElement>('[data-routine-editor] button[type="submit"]')
      ?.click()
  }
})

export const webhookCreated = defineFixture({
  width: 820,
  render: () => (
    <CloudRoutinesView
      {...props}
      initial={{
        editor: {
          routineId: null,
          webhookUrl: 'https://api.orca.dev/hooks/rt_9fK2/x7Qm2LpV9cWfK4nY8sJd1Hg6'
        }
      }}
    />
  )
})

export const deleteConfirm = defineFixture({
  width: 820,
  render: () => <CloudRoutinesView {...props} initial={{ deleteId: 'rt_fix' }} />
})
