import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'
import type { CloudMoveConflicts } from './CloudMoveToComputerView'
import { CloudMoveConfirmDialog } from './CloudMoveConfirmDialog'
import { CloudMoveProgressCardView, type CloudMoveCardState } from './CloudMoveProgressCard'
import { CloudMovingNotice } from './CloudWorkspaceNotice'

const NOW = Date.now()
const noop = (): void => {}
const noConflicts: CloudMoveConflicts = { branchCheckedOutLocally: null }

const prepared = {
  transferId: 't1',
  repoId: 'r1',
  branch: 'fix-auth-redirect',
  cloudBranch: 'fix-auth-redirect',
  baseBranch: 'main',
  counts: { untrackedFiles: 3, claudeSessions: 2, codexSessions: 0, hasChanges: true }
}
const finished = {
  worktreePath: '/Users/me/orca/fix-auth-redirect',
  appliedStaged: true,
  appliedUnstaged: true,
  untrackedFiles: 3,
  claudeSessions: 2,
  codexSessions: 1,
  leftoverPatchDir: null
}

/** The confirm dialog as it renders (the real dialog, open). */
function Frame({
  state,
  conflicts = noConflicts,
  runningAgents = 0
}: {
  state: Extract<CloudMoveState, { stage: 'confirm' }>
  conflicts?: CloudMoveConflicts
  runningAgents?: number
}): React.JSX.Element {
  return (
    <div className="h-[360px] bg-background">
      <CloudMoveConfirmDialog
        state={state}
        conflicts={conflicts}
        runningAgents={runningAgents}
        onConfirm={noop}
        onClose={noop}
        onArchiveAfterChange={noop}
      />
    </div>
  )
}

/** The progress card as it renders in the notification stack (360px wide). */
function CardFrame({
  state,
  reapply = false
}: {
  state: CloudMoveCardState
  reapply?: boolean
}): React.JSX.Element {
  return (
    <div className="w-[360px] [&_[data-slot=card]]:border-(--notice-border) [&_[data-slot=card]]:shadow-notice">
      <CloudMoveProgressCardView
        state={state}
        now={NOW}
        onMinimize={noop}
        onDismiss={noop}
        onCancelMove={noop}
        onRetry={noop}
        onReapply={reapply ? noop : undefined}
        onOpenLocal={noop}
        onOpenFolder={noop}
      />
    </div>
  )
}

const base = { workspaceId: 'ws', name: 'fix-auth-redirect' }

export const moveConfirm = defineFixture({
  width: 640,
  render: () => (
    <Frame
      state={{
        stage: 'confirm',
        ...base,
        known: { branch: 'fix-auth-redirect', uncommittedChanges: 4, chats: 2 },
        archiveAfter: true
      }}
    />
  )
})

// Already archived: no "Archive afterwards" choice; it is archived again after the move.
export const moveConfirmArchived = defineFixture({
  width: 640,
  render: () => (
    <Frame
      state={{
        stage: 'confirm',
        ...base,
        known: { branch: 'fix-auth-redirect', uncommittedChanges: 4, chats: 2 },
        archiveAfter: null,
        archived: true
      }}
    />
  )
})

export const moveConfirmBranchTaken = defineFixture({
  width: 640,
  render: () => (
    <Frame
      state={{ stage: 'confirm', ...base, known: null, archiveAfter: null }}
      conflicts={{
        branchCheckedOutLocally: { branch: 'fix-auth-redirect' }
      }}
      // An agent is working there, so archive-afterwards defaults off (archiving would stop it).
      runningAgents={1}
    />
  )
})

export const moveRunningFromSleep = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'running',
        ...base,
        step: 'downloading',
        skipped: [],
        startedAt: NOW - 14_000,
        bytes: 18 * 1024 * 1024,
        totalBytes: 41 * 1024 * 1024,
        archiveAfter: false,
        cancel: 'available',
        minimized: false
      }}
    />
  )
})

export const moveRunningAwake = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'running',
        ...base,
        step: 'applying',
        skipped: ['waking'],
        startedAt: NOW - 3_000,
        bytes: null,
        totalBytes: null,
        archiveAfter: true,
        cancel: null,
        minimized: false
      }}
    />
  )
})

export const moveDone = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'done',
        ...base,
        localWorktreeId: 'l1',
        prepared,
        finished,
        elapsedMs: 8_300,
        archivedAfter: true,
        archiveAfter: true,
        minimized: false
      }}
    />
  )
})

export const moveDonePartial = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'done',
        ...base,
        localWorktreeId: 'l1',
        prepared: { ...prepared, branch: 'fix-auth-redirect-2' },
        finished: { ...finished, leftoverPatchDir: '/Users/me/Library/Orca/cloud-transfers/t1' },
        elapsedMs: 9_100,
        archivedAfter: false,
        archiveAfter: false,
        minimized: false
      }}
      reapply
    />
  )
})

export const moveFailed = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'failed',
        ...base,
        step: 'downloading',
        timedOut: false,
        reason: null,
        retryable: true,
        restored: null,
        archiveAfter: true,
        localWorktreeId: null,
        minimized: false
      }}
    />
  )
})

export const moveFailedAfterLocal = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'failed',
        ...base,
        step: 'applying',
        timedOut: false,
        reason: null,
        retryable: true,
        restored: null,
        archiveAfter: true,
        localWorktreeId: 'l1',
        minimized: false
      }}
    />
  )
})

export const moveRunningCancelling = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'running',
        ...base,
        step: 'packing',
        skipped: ['waking'],
        startedAt: NOW - 6_000,
        bytes: null,
        totalBytes: null,
        archiveAfter: false,
        cancel: 'cancelling',
        minimized: false
      }}
    />
  )
})

/** The cloud workspace's page while a move captures it: panes stay usable, with this note. */
export const movingNotice = defineFixture({
  width: 400,
  render: () => <CloudMovingNotice />
})

/** Main's reason, named; Retry isn't offered for a failure it would repeat. */
export const moveFailedTooLarge = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'failed',
        ...base,
        step: 'packing',
        timedOut: false,
        reason: 'too_large',
        retryable: false,
        restored: null,
        archiveAfter: false,
        localWorktreeId: null,
        minimized: false
      }}
    />
  )
})

/** An archived workspace whose move failed: it is archived again. */
export const moveFailedRestoredArchive = defineFixture({
  width: 400,
  render: () => (
    <CardFrame
      state={{
        stage: 'failed',
        ...base,
        step: 'downloading',
        timedOut: false,
        reason: null,
        retryable: true,
        restored: 'archived',
        archiveAfter: false,
        localWorktreeId: null,
        minimized: false
      }}
    />
  )
})

/** After the move: the cloud workspace stays usable, with a quiet "Copied to this computer" line. */
export const panelMovedToComputer = defineFixture({
  width: 320,
  setup: () =>
    window.localStorage.setItem(
      'orca-cloud-moved-at:ws',
      JSON.stringify({ at: Date.UTC(2026, 11, 7), localWorktreeId: 'local-ws' })
    ),
  render: () => (
    <div className="rounded-md border border-border bg-floating-surface p-3">
      <CloudWorkspaceStatusPanel
        workspaceId="ws"
        state="running"
        entry={{
          status: {
            state: 'ready',
            metrics: {
              cpuPercent: 12,
              cpus: 4,
              load1: 0.4,
              memTotalBytes: 8e9,
              memUsedBytes: 2.1e9,
              diskTotalBytes: 34.3e9,
              diskUsedBytes: 6.2e9,
              uptimeSeconds: 3_600,
              oomKills: 0,
              lastOomVictim: null,
              orcadAlive: true
            },
            uptimeMs: 3_600_000,
            usage: { totalMs: 2.4 * 3_600_000, centsPerHour: 100, costCents: 240 },
            archive: null,
            checkedAt: NOW
          },
          loading: false,
          error: null,
          fetchedAt: NOW - 42_000
        }}
        pending={undefined}
        actions={{
          onWake: noop,
          onRestart: noop,
          onArchive: noop,
          onUnarchive: noop,
          onMoveToComputer: noop
        }}
      />
    </div>
  )
})
