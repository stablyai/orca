import React from 'react'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/row-display/git-identity-display'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { UncommittedEntryRow } from '../listing/uncommitted-entry-row'
import { SourceControlBranchContextRow } from './branch-context-row'
import type { RebaseContinueState } from './base-rebase-state'
import { OperationRow, type OperationRowOperation } from './operation-row'
import { RebaseOperationRow, type BaseRebaseActions } from './rebase-operation-row'

type Scenario = {
  kind: OperationRowOperation | null
  conflicts: number
  ai?: boolean
  long?: boolean
  continueState?: RebaseContinueState
  /** Which in-flight step to show, or an Abort the host can't run. */
  busy?: 'continue' | 'resolve' | 'abort' | 'host-unsupported'
}

const LONG_BRANCH = 'feature/source-control-rebase-operation-banner-redesign-follow-up'
const SHA = '0e97274d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a'

function files(conflicts: number): GitStatusEntry[] {
  const conflicted: GitStatusEntry[] = ['src/billing/ledger.ts', 'src/billing/reconcile.test.ts']
    .slice(0, conflicts)
    .map((path) => ({
      path,
      status: 'modified',
      area: 'unstaged',
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved'
    }))
  return [
    ...conflicted,
    { path: 'src/renderer/operation-row.tsx', status: 'added', area: 'unstaged' },
    { path: 'README.md', status: 'modified', area: 'unstaged' }
  ]
}

function Row({
  kind,
  conflicts,
  ai = true,
  long,
  continueState = 'ready',
  busy
}: Scenario & { kind: OperationRowOperation }): React.JSX.Element {
  const resolve = ai ? { busy: busy === 'resolve', onPress: () => {} } : null
  const branch = long ? LONG_BRANCH : 'feature/ledger'
  const detached = getWorktreeGitIdentityDisplay({ head: SHA })
  const note = detached?.kind === 'detached' ? detached.sourceControlLabel : null
  if (kind === 'rebase') {
    const paused = {
      kind: 'rebase_paused',
      unresolvedCount: conflicts,
      continueState,
      inspectFailureMessage: null
    } as const
    const actions: BaseRebaseActions = {
      state: paused,
      isAbortingRebase: false,
      isContinuingRebase: busy === 'continue',
      isRetryingRebaseInspect: false,
      hasGitOwner: true,
      onAbortRebase: () => {},
      onContinueRebase: () => {},
      onRetryRebaseInspect: () => {}
    }
    return (
      <RebaseOperationRow
        actions={actions}
        paused={paused}
        branch={branch}
        notes={[note]}
        ai={resolve}
        abortTargetKey="fixture|rebase"
      />
    )
  }
  return (
    <OperationRow
      operation={kind}
      branch={branch}
      primary={
        // Mirrors the panel: an aborting row or an unsupported host offers no step.
        busy === 'abort' || busy === 'host-unsupported'
          ? null
          : conflicts > 0
            ? resolve && { kind: 'resolve', ...resolve }
            : { kind: 'continue', busy: busy === 'continue', onPress: () => {} }
      }
      abort={{
        unavailable: busy === 'abort' || busy === 'host-unsupported',
        busy: busy === 'abort',
        reason:
          busy === 'host-unsupported'
            ? 'This host runs an older Orca that cannot continue or abort a cherry-pick.'
            : null,
        onAbort: () => {}
      }}
      abortTargetKey={`fixture|${kind}`}
    />
  )
}

/** The header block and file rows around the row, so its edges can be checked against both. */
function Panel(scenario: Scenario): React.JSX.Element {
  const { kind } = scenario
  return (
    <div className="flex flex-col bg-sidebar text-foreground">
      <div className="flex flex-col border-b border-border px-3 py-1">
        <SourceControlBranchContextRow
          summary={null}
          compareBaseRef={null}
          headDisplay={getWorktreeGitIdentityDisplay({ head: SHA })}
          operationRow={kind ? <Row {...scenario} kind={kind} /> : null}
          onRetry={() => {}}
        />
      </div>
      <div className="pt-1">
        {files(scenario.conflicts).map((entry) => (
          <UncommittedEntryRow
            key={entry.path}
            entryKey={entry.path}
            entry={entry}
            currentWorktreeId="fixture-workspace"
            worktreePath="/workspace/ledger"
            onRevealInExplorer={() => {}}
            onOpen={() => {}}
            onStage={async () => {}}
            onResolveConflict={async () => {}}
            onUnstage={async () => {}}
            onDiscard={() => {}}
            commentCount={0}
          />
        ))}
      </div>
    </div>
  )
}

// The fixture frame pads 16px per side; the widths below are the panel's own.
function at(width: number, scenario: Scenario) {
  return defineFixture({ width: width + 32, render: () => <Panel {...scenario} /> })
}

export const rebaseReady320 = at(320, { kind: 'rebase', conflicts: 0, long: true })
export const rebaseReady260 = at(260, { kind: 'rebase', conflicts: 0 })
export const rebaseReady220 = at(220, { kind: 'rebase', conflicts: 0, long: true })
export const rebaseConflicts320 = at(320, { kind: 'rebase', conflicts: 2, long: true })
export const rebaseConflicts260 = at(260, { kind: 'rebase', conflicts: 2 })
export const rebaseConflicts220 = at(220, { kind: 'rebase', conflicts: 2, long: true })
export const rebaseConflictsNoAi260 = at(260, { kind: 'rebase', conflicts: 2, ai: false })
export const rebaseEmptyStep260 = at(260, { kind: 'rebase', conflicts: 0, continueState: 'empty' })
export const rebaseCheckFailed220 = at(220, {
  kind: 'rebase',
  conflicts: 0,
  continueState: 'unreadable'
})
export const mergeReady260 = at(260, { kind: 'merge', conflicts: 0 })
export const mergeConflicts320 = at(320, { kind: 'merge', conflicts: 1, long: true })
export const cherryPickConflicts220 = at(220, { kind: 'cherry-pick', conflicts: 2, long: true })
export const detachedHead320 = at(320, { kind: null, conflicts: 0 })
export const detachedHead260 = at(260, { kind: null, conflicts: 0 })
export const detachedHead220 = at(220, { kind: null, conflicts: 0 })

export const rebaseAbortArmed = defineFixture({
  width: 260 + 32,
  render: () => <Panel kind="rebase" conflicts={2} />,
  interact: async (frame) => {
    frame
      .querySelector('button[aria-label="More actions"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    document.querySelector<HTMLElement>('[role="menuitem"]')?.click()
  }
})

export const mergeContinuing260 = at(260, { kind: 'merge', conflicts: 0, busy: 'continue' })
export const rebaseResolveChecking260 = at(260, { kind: 'rebase', conflicts: 2, busy: 'resolve' })
export const mergeAborting260 = at(260, { kind: 'merge', conflicts: 0, busy: 'abort' })

export const cherryPickHostUnsupported = defineFixture({
  width: 260 + 32,
  render: () => <Panel kind="cherry-pick" conflicts={0} busy="host-unsupported" />,
  interact: async (frame) => {
    frame
      .querySelector('button[aria-label="More actions"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
})
