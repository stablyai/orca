import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import {
  CloudMoveToComputerView,
  cloudMoveTitle,
  type CloudMoveConflicts
} from './CloudMoveToComputerDialog'

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
  conflicts = noConflicts
}: {
  state: Exclude<CloudMoveState, { stage: 'closed' }>
  conflicts?: CloudMoveConflicts
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-lg">
      <h2 className="text-lg font-semibold leading-none">{cloudMoveTitle(state, t)}</h2>
      <CloudMoveToComputerView
        state={state}
        conflicts={conflicts}
        now={NOW}
        onConfirm={noop}
        onCancel={noop}
        onOpenFolder={noop}
        onArchiveCloud={noop}
        onClose={noop}
      />
    </div>
  )
}

const base = { workspaceId: 'ws', name: 'fix-auth-redirect' }

export const moveConfirm = defineFixture({
  width: 460,
  render: () => <Frame state={{ stage: 'confirm', ...base }} />
})

export const moveConfirmBranchTaken = defineFixture({
  width: 460,
  render: () => (
    <Frame
      state={{ stage: 'confirm', ...base }}
      conflicts={{ branchCheckedOutLocally: 'fix-auth-redirect' }}
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
        totalBytes: 41 * 1024 * 1024
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
        totalBytes: null
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
        elapsedMs: 8_300
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
        elapsedMs: 9_100
      }}
    />
  )
})

export const moveFailed = defineFixture({
  width: 460,
  render: () => <Frame state={{ stage: 'failed', ...base, step: 'downloading' }} />
})
