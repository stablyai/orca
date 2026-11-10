import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'
import {
  CloudMoveToComputerView,
  cloudMoveTitle,
  type CloudMoveConflicts
} from './CloudMoveToComputerView'

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

/** The dialog as it renders: title + body, framed like DialogContent. */
function Frame({
  state,
  conflicts = noConflicts,
  runningAgents = 0
}: {
  state: Exclude<CloudMoveState, { stage: 'closed' }>
  conflicts?: CloudMoveConflicts
  runningAgents?: number
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-lg">
      <h2 className="text-lg font-semibold leading-none">{cloudMoveTitle(state, t)}</h2>
      <CloudMoveToComputerView
        state={state}
        conflicts={conflicts}
        runningAgents={runningAgents}
        now={NOW}
        onConfirm={noop}
        onCancel={noop}
        onOpenFolder={noop}
        onArchiveCloud={noop}
        onOpenLocal={noop}
        onClose={noop}
        onArchiveAfterChange={noop}
        onHide={noop}
      />
    </div>
  )
}

const base = { workspaceId: 'ws', name: 'fix-auth-redirect' }

export const moveConfirm = defineFixture({
  width: 460,
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

export const moveConfirmBranchTaken = defineFixture({
  width: 460,
  render: () => (
    <Frame
      state={{ stage: 'confirm', ...base, known: null, archiveAfter: null }}
      conflicts={{
        branchCheckedOutLocally: { branch: 'fix-auth-redirect', newName: 'fix-auth-redirect-2' }
      }}
      // An agent is working there, so archive-afterwards defaults off (archiving would stop it).
      runningAgents={1}
    />
  )
})

export const moveRunningFromSleep = defineFixture({
  width: 460,
  render: () => (
    <Frame
      state={{
        stage: 'running',
        ...base,
        step: 'downloading',
        skipped: [],
        startedAt: NOW - 14_000,
        bytes: 18 * 1024 * 1024,
        totalBytes: 41 * 1024 * 1024,
        archiveAfter: false,
        hidden: false
      }}
    />
  )
})

export const moveRunningAwake = defineFixture({
  width: 460,
  render: () => (
    <Frame
      state={{
        stage: 'running',
        ...base,
        step: 'applying',
        skipped: ['waking'],
        startedAt: NOW - 3_000,
        bytes: null,
        totalBytes: null,
        archiveAfter: true,
        hidden: false
      }}
    />
  )
})

export const moveDone = defineFixture({
  width: 460,
  render: () => (
    <Frame
      state={{
        stage: 'done',
        ...base,
        localWorktreeId: 'l1',
        prepared,
        finished,
        elapsedMs: 8_300,
        archivedAfter: true,
        hidden: false
      }}
    />
  )
})

export const moveDonePartial = defineFixture({
  width: 460,
  render: () => (
    <Frame
      state={{
        stage: 'done',
        ...base,
        localWorktreeId: 'l1',
        prepared: { ...prepared, branch: 'fix-auth-redirect-2' },
        finished: { ...finished, leftoverPatchDir: '/Users/me/Library/Orca/cloud-transfers/t1' },
        elapsedMs: 9_100,
        archivedAfter: false,
        hidden: false
      }}
    />
  )
})

export const moveFailed = defineFixture({
  width: 460,
  render: () => (
    <Frame
      state={{
        stage: 'failed',
        ...base,
        step: 'downloading',
        timedOut: false,
        archiveAfter: true,
        localWorktreeId: null,
        hidden: false
      }}
    />
  )
})

export const moveFailedAfterLocal = defineFixture({
  width: 460,
  render: () => (
    <Frame
      state={{
        stage: 'failed',
        ...base,
        step: 'applying',
        timedOut: false,
        archiveAfter: true,
        localWorktreeId: 'l1',
        hidden: false
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
