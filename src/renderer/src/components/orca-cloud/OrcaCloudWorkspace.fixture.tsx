import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { seedCloudWorkspaceSnapshot, type CloudStatusEntry } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { CloudArchiveInfo, CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { CloudArchivedWorkspaceView } from './CloudArchivedWorkspaceView'
import { CloudStateDot } from './CloudStateDot'
import { cloudStateLabel } from './cloud-state-copy'
import { CloudWakingOverlay } from './CloudWakingOverlay'
import { CloudWorkspaceMark } from './CloudWorkspaceMark'
import { CloudWorkspaceNotice } from './CloudWorkspaceNotice'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'

const NOW = Date.now()
const noop = (): void => {}
const actions = { onRestart: noop, onArchive: noop, onUnarchive: noop }

const running: HostedWorkspaceStatus = {
  state: 'ready',
  metrics: {
    cpuPercent: 37,
    cpus: 4,
    load1: 1.2,
    memTotalBytes: 8e9,
    memUsedBytes: 5.1e9,
    diskTotalBytes: 34.3e9,
    diskUsedBytes: 6.2e9,
    uptimeSeconds: 7_420,
    oomKills: 0,
    lastOomVictim: null,
    orcadAlive: true
  },
  uptimeMs: 2 * 3_600_000 + 3 * 60_000,
  usage: { totalMs: 14.6 * 3_600_000, centsPerHour: 75, costCents: 1095 },
  archive: null,
  checkedAt: NOW
}
const entry = (status: HostedWorkspaceStatus | null, over: Partial<CloudStatusEntry> = {}): CloudStatusEntry => ({
  status,
  loading: false,
  error: null,
  fetchedAt: NOW - 4_000,
  ...over
})

function Panel({ state, value, pending }: { state: CloudDotState; value: CloudStatusEntry | undefined; pending?: 'restart' }) {
  return (
    <div className="rounded-md border border-border bg-floating-surface p-3">
      <CloudWorkspaceStatusPanel workspaceId="ws" state={state} entry={value} pending={pending} actions={actions} />
    </div>
  )
}

export const panelRunning = defineFixture({ width: 300, render: () => <Panel state="running" value={entry(running)} /> })

export const panelUnresponsive = defineFixture({
  width: 300,
  render: () => (
    <Panel
      state="unresponsive"
      value={entry({ ...running, state: 'unresponsive', metrics: { ...running.metrics!, cpuPercent: 99, orcadAlive: false } })}
    />
  )
})

export const panelRestarting = defineFixture({
  width: 300,
  render: () => <Panel state="unresponsive" value={entry({ ...running, state: 'unresponsive' })} pending="restart" />
})

export const panelSleeping = defineFixture({
  width: 300,
  render: () => (
    <Panel state="sleeping" value={entry({ ...running, state: 'sleeping', metrics: null, uptimeMs: null })} />
  )
})

export const panelArchived = defineFixture({
  width: 300,
  render: () => (
    <Panel
      state="archived"
      value={entry({
        ...running,
        state: 'archived',
        metrics: null,
        uptimeMs: null,
        archive: { archivedAt: NOW - 86_400_000, expiresAt: NOW + 29 * 86_400_000 }
      })}
    />
  )
})

export const panelLoading = defineFixture({
  width: 300,
  render: () => <Panel state="unknown" value={entry(null, { loading: true, fetchedAt: null })} />
})

export const panelError = defineFixture({
  width: 300,
  render: () => <Panel state="unknown" value={entry(null, { error: 'unreachable', fetchedAt: null })} />
})

const DOT_STATES: CloudDotState[] = ['running', 'sleeping', 'waking', 'unresponsive', 'archived', 'failed', 'unknown']

export const dotStates = defineFixture({
  width: 240,
  render: () => (
    <ul className="flex flex-col gap-2 bg-worktree-sidebar p-3 text-xs text-worktree-sidebar-foreground">
      {DOT_STATES.map((state) => (
        <li key={state} className="flex items-center gap-2">
          <CloudStateDot state={state} />
          {cloudStateLabel(state)}
        </li>
      ))}
    </ul>
  )
})

/** The sidebar mark with its status panel open. */
export const sidebarMarkOpen = defineFixture({
  width: 420,
  setup: () => {
    seedCloudWorkspaceSnapshot({ ids: new Set(['ws']), status: { ws: entry(running) } })
    window.api.orcaCloudWorkspace = {
      ...window.api.orcaCloudWorkspace,
      getStatus: async () => ({ ok: true, value: running })
    }
  },
  render: () => (
    <div className="h-72 bg-worktree-sidebar p-3 text-worktree-sidebar-foreground">
      <div className="flex w-56 items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px]">
        <CloudWorkspaceMark workspaceId="ws" />
        <span className="truncate">fix-auth-redirect</span>
      </div>
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-cloud-workspace-mark]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

const wake = (over: Partial<CloudWakeProgressEvent> = {}): CloudWakeProgressEvent => ({
  workspaceId: 'ws',
  phase: 'waking',
  source: 'open',
  startedAt: NOW - 3_200,
  at: NOW,
  ...over
})

function Pane({ children }: { children: React.ReactNode }) {
  return <div className="relative h-[340px] overflow-hidden rounded-md border border-border bg-background">{children}</div>
}

export const wakingOverlay = defineFixture({
  width: 640,
  render: () => (
    <Pane>
      <CloudWakingOverlay wake={wake()} workspaceName="fix-auth-redirect" onRetry={noop} onRestart={noop} />
    </Pane>
  )
})

export const wakingRestart = defineFixture({
  width: 640,
  render: () => (
    <Pane>
      <CloudWakingOverlay wake={wake({ source: 'restart' })} workspaceName="fix-auth-redirect" onRetry={noop} onRestart={noop} />
    </Pane>
  )
})

export const wakingFailed = defineFixture({
  width: 640,
  render: () => (
    <Pane>
      <CloudWakingOverlay
        wake={wake({ phase: 'failed', message: 'Orca Cloud did not answer in time.' })}
        workspaceName="fix-auth-redirect"
        onRetry={noop}
        onRestart={noop}
      />
    </Pane>
  )
})

export const noticeUnresponsive = defineFixture({
  width: 420,
  render: () => (
    <div className="bg-background p-4">
      <CloudWorkspaceNotice notice={{ kind: 'unresponsive' }} restarting={false} onRestart={noop} />
    </div>
  )
})

export const noticeOom = defineFixture({
  width: 420,
  render: () => (
    <div className="bg-background p-4">
      <CloudWorkspaceNotice
        notice={{ kind: 'oom', oom: { workspaceId: 'ws', oomKills: 1, victim: 'node', at: NOW } }}
        restarting={false}
        onRestart={noop}
        onDismiss={noop}
      />
    </div>
  )
})

const archive: CloudArchiveInfo = {
  capturedAt: NOW - 86_400_000,
  source: 'vm',
  metadata: {
    pullRequests: [
      { number: 482, title: 'Fix OAuth redirect loop on expired sessions', state: 'open', url: 'https://github.com/acme/web/pull/482' },
      { number: 477, title: 'Add session refresh telemetry', state: 'merged', url: 'https://github.com/acme/web/pull/477' }
    ],
    checkouts: [
      {
        path: '/vercel/sandbox/project',
        branch: 'fix/auth-redirect',
        head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        upstream: 'origin/fix/auth-redirect',
        ahead: 2,
        behind: 0,
        commits: [
          { sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', author: 'Ada', at: NOW - 26 * 3_600_000, subject: 'Refresh the session before redirecting' },
          { sha: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3', author: 'Ada', at: NOW - 28 * 3_600_000, subject: 'Reproduce the redirect loop in a test' },
          { sha: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', author: 'Grace', at: NOW - 5 * 86_400_000, subject: 'Bump next to 16.2' }
        ],
        changes: [
          { status: 'M', path: 'src/auth/session.ts' },
          { status: '??', path: 'src/auth/session.test.ts' }
        ],
        diffStat: '2 files changed, 41 insertions(+), 6 deletions(-)',
        fileCount: 2412,
        files: ['README.md', 'package.json', 'src/auth/session.ts', 'src/auth/session.test.ts', 'src/auth/redirect.ts', 'src/app/page.tsx', 'src/app/layout.tsx', 'tsconfig.json']
      }
    ]
  }
}

function Archived({ load }: { load: React.ComponentProps<typeof CloudArchivedWorkspaceView>['load'] }) {
  return (
    <div className="relative h-[620px]">
      <CloudArchivedWorkspaceView
        workspaceName="fix-auth-redirect"
        archivedAt={NOW - 86_400_000}
        expiresAt={NOW + 29 * 86_400_000}
        load={load}
        unarchiving={false}
        onUnarchive={noop}
        onRetry={noop}
        onOpenUrl={noop}
        now={NOW}
      />
    </div>
  )
}

export const archivedView = defineFixture({ width: 820, render: () => <Archived load={{ status: 'ready', archive }} /> })
export const archivedEmpty = defineFixture({ width: 820, render: () => <Archived load={{ status: 'ready', archive: null }} /> })
export const archivedLoading = defineFixture({ width: 820, render: () => <Archived load={{ status: 'loading' }} /> })
export const archivedError = defineFixture({ width: 820, render: () => <Archived load={{ status: 'error', message: 'x' }} /> })
