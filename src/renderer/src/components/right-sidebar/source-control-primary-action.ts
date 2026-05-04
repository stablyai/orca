// Why: split from the combined primary+dropdown module because the primary and dropdown are independent derivations with different priority ladders; together they exceed the max-lines budget and tangle unrelated concerns.

import type { GitUpstreamStatus } from '../../../../shared/types'

// Why: this module owns the pure state-machine logic for the Source Control
// primary action (split button). Keeping the logic outside the React component
// makes it straightforward to unit-test each row of the priority table without
// spinning up a renderer.

// Why: the primary button collapses to one-label-per-action. Compound
// kinds ('commit_push', 'commit_sync', 'commit_publish') live in
// DropdownActionKind only — never on the primary — so they are not part
// of this union. Narrowing the type here is load-bearing: it lets
// `handlePrimaryClick` switch exhaustively over only the kinds the
// primary can actually emit, and it kills the compound-commit branch in
// the isRemoteOperationActive tooltip below at compile time.
export type PrimaryActionKind = 'commit' | 'push' | 'pull' | 'sync' | 'publish'

export type PrimaryAction = {
  kind: PrimaryActionKind
  label: string
  title: string
  disabled: boolean
}

export type PrimaryActionInputs = {
  stagedCount: number
  hasMessage: boolean
  hasUnresolvedConflicts: boolean
  isCommitting: boolean
  isRemoteOperationActive: boolean
  upstreamStatus: GitUpstreamStatus | undefined
}

function describePushCount(ahead: number): string {
  return `Push ${ahead} commit${ahead === 1 ? '' : 's'}`
}

function describePullCount(behind: number): string {
  return `Pull ${behind} commit${behind === 1 ? '' : 's'}`
}

function describeSyncCounts(ahead: number, behind: number): string {
  return `Pull ${behind}, push ${ahead}`
}

/**
 * Resolve the primary split-button action.
 *
 * Priority order mirrors the design-doc state machine:
 *   1. In-flight commit locks the primary to a disabled "Commit".
 *   2. In-flight remote operation keeps the current label but disables it.
 *   3. Unresolved conflicts block the commit path entirely.
 *   4. Has staged files + message → plain "Commit" (compound flows live in
 *      the dropdown; after the commit lands, step 6 rotates the primary to
 *      the appropriate single remote action).
 *   5. Has staged files + no message → disabled "Commit" with a reason.
 *   6. Clean tree → adaptive remote action (or disabled "Commit" no-op).
 *
 * An undefined upstream status means fetchUpstreamStatus has not resolved
 * yet for this worktree. We return a disabled Commit so the button has a
 * stable frame until the real status lands — otherwise it would flash
 * through "Publish Branch" on every worktree switch.
 */
export function resolvePrimaryAction(inputs: PrimaryActionInputs): PrimaryAction {
  const {
    stagedCount,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    upstreamStatus
  } = inputs

  // 1. Commit in flight — lock the primary no matter what else is true.
  if (isCommitting) {
    return {
      kind: 'commit',
      label: 'Commit',
      title: 'Commit in progress…',
      disabled: true
    }
  }

  // 2. Remote op in flight — keep the label that matches the current state
  //    but disable the button so the user can't stack a second operation on
  //    top of the running one. We compute the candidate label by recursing
  //    with isRemoteOperationActive cleared, then force-disable it.
  if (isRemoteOperationActive) {
    const candidate = resolvePrimaryAction({ ...inputs, isRemoteOperationActive: false })
    // Why: when the candidate label is "Commit", the generic "remote
    // operation in progress…" tooltip mismatches the visible label. Point
    // the user at the fact that the commit will wait, keeping the label and
    // the explanation consistent.
    return {
      ...candidate,
      title:
        candidate.kind === 'commit'
          ? 'Remote operation in progress — try again once it finishes'
          : 'Remote operation in progress…',
      disabled: true
    }
  }

  // 3. Unresolved conflicts block any commit path.
  if (hasUnresolvedConflicts) {
    return {
      kind: 'commit',
      label: 'Commit',
      title: 'Resolve conflicts before committing',
      disabled: true
    }
  }

  const hasStaged = stagedCount > 0

  // 4. Has staged files + message → plain Commit. The primary button never
  //    compounds ("Commit & Push" etc.) — after the commit lands, the primary
  //    naturally rotates to the appropriate remote action (Push / Sync /
  //    Publish Branch) via step 6 below. Users who want the one-click
  //    compound flow can still reach it from the dropdown.
  if (hasStaged && hasMessage) {
    return {
      kind: 'commit',
      label: 'Commit',
      title: 'Commit staged changes',
      disabled: false
    }
  }

  // 5. Has staged files but no message — user just needs to type something.
  if (hasStaged && !hasMessage) {
    return {
      kind: 'commit',
      label: 'Commit',
      title: 'Enter a commit message to commit',
      disabled: true
    }
  }

  // 6. Clean tree + no staged files → adaptive remote action.
  if (!upstreamStatus) {
    return {
      kind: 'commit',
      label: 'Commit',
      title: 'Stage at least one file to commit',
      disabled: true
    }
  }

  if (!upstreamStatus.hasUpstream) {
    return {
      kind: 'publish',
      label: 'Publish Branch',
      title: 'Publish this branch to origin',
      disabled: false
    }
  }

  if (upstreamStatus.ahead > 0 && upstreamStatus.behind > 0) {
    return {
      kind: 'sync',
      label: 'Sync',
      title: describeSyncCounts(upstreamStatus.ahead, upstreamStatus.behind),
      disabled: false
    }
  }
  if (upstreamStatus.behind > 0) {
    return {
      kind: 'pull',
      label: 'Pull',
      title: describePullCount(upstreamStatus.behind),
      disabled: false
    }
  }
  if (upstreamStatus.ahead > 0) {
    return {
      kind: 'push',
      label: 'Push',
      title: describePushCount(upstreamStatus.ahead),
      disabled: false
    }
  }

  // Clean + tracked + in sync — nothing to do on this branch.
  return {
    kind: 'commit',
    label: 'Commit',
    title: 'Nothing to commit. Branch is up to date.',
    disabled: true
  }
}
