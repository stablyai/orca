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
export type PrimaryActionKind = 'commit' | 'stage' | 'push' | 'pull' | 'sync' | 'publish'

// Why: the in-flight remote op tracker stores which action the user actually
// triggered, so the primary button can mirror that label/spinner instead of
// claiming a stale or unrelated operation is running. 'fetch' is included
// because Fetch participates in the busy flag, but it is intentionally NOT
// in PrimaryActionKind — Fetch is dropdown-only, so when fetch is in flight
// the primary keeps its natural label and CommitArea suppresses the spinner.
export type RemoteOpKind = 'push' | 'pull' | 'sync' | 'fetch' | 'publish'

export type PrimaryAction = {
  kind: PrimaryActionKind
  label: string
  title: string
  disabled: boolean
}

export type PrimaryActionInputs = {
  stagedCount: number
  hasUnstagedChanges: boolean
  hasMessage: boolean
  hasUnresolvedConflicts: boolean
  isCommitting: boolean
  isRemoteOperationActive: boolean
  upstreamStatus: GitUpstreamStatus | undefined
  // Why: which remote op is currently running, when one is. null when no
  // remote op is in flight. Used by the in-flight branch below to mirror
  // the user-triggered action on the primary button instead of leaving a
  // stale label that no longer matches what the slice is doing.
  inFlightRemoteOpKind?: RemoteOpKind | null
}

const PRIMARY_LABEL_BY_KIND: Record<Exclude<PrimaryActionKind, 'commit'>, string> = {
  stage: 'Stage Files',
  push: 'Push',
  pull: 'Pull',
  sync: 'Sync',
  publish: 'Publish Branch'
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
    hasUnstagedChanges,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    upstreamStatus,
    inFlightRemoteOpKind
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

  // 2. Remote op in flight — disable the primary. When the in-flight op
  //    is a primary-eligible kind that doesn't match the primary's natural
  //    label, mirror the in-flight kind so the user sees the action they
  //    actually triggered (e.g. "Sync" when they picked Sync from the
  //    dropdown while the primary's natural state was "Push"). When the
  //    in-flight op matches the primary's natural kind we keep the natural
  //    label so its richer detail (counts like "Push 3 commits") survives.
  //    Fetch and unknown in-flight kinds leave the primary's natural label
  //    intact; CommitArea's spinner suppresses itself via the kind-mismatch
  //    check so a non-matching in-flight op doesn't visually claim the
  //    primary as its host.
  if (isRemoteOperationActive) {
    const candidate = resolvePrimaryAction({ ...inputs, isRemoteOperationActive: false })
    const inFlightIsPrimaryKind =
      inFlightRemoteOpKind === 'push' ||
      inFlightRemoteOpKind === 'pull' ||
      inFlightRemoteOpKind === 'sync' ||
      inFlightRemoteOpKind === 'publish'

    if (inFlightIsPrimaryKind && candidate.kind !== inFlightRemoteOpKind) {
      const label = PRIMARY_LABEL_BY_KIND[inFlightRemoteOpKind]
      return {
        kind: inFlightRemoteOpKind,
        label,
        title: `${label} in progress…`,
        disabled: true
      }
    }

    // Why: when the candidate label is "Commit", the generic "remote
    // operation in progress…" tooltip mismatches the visible label. Point
    // the user at the fact that the commit will wait, keeping the label and
    // the explanation consistent. Conflicts take precedence over the remote
    // tooltip because resolving them is the only action the user can start
    // while the remote op runs.
    const title = hasUnresolvedConflicts
      ? 'Resolve conflicts before committing'
      : candidate.kind === 'commit'
        ? 'Remote operation in progress — try again once it finishes'
        : 'Remote operation in progress…'
    return {
      ...candidate,
      title,
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

  // 5b. Nothing staged but local changes exist — surface staging as the
  //     primary so dirty trees don't invite a remote op (pull/sync would fail
  //     with uncommitted changes; push/publish skips the actual user need).
  //     Sits before the upstream-status checks so it works regardless of
  //     whether upstream has resolved yet.
  if (!hasStaged && hasUnstagedChanges) {
    return {
      kind: 'stage',
      label: 'Stage Files',
      title: 'Stage all changes',
      disabled: false
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

  // Clean + tracked + in sync — distinguish truly clean from work that still
  // needs staging before commit can proceed.
  return {
    kind: 'commit',
    label: 'Commit',
    title: hasUnstagedChanges
      ? 'Stage at least one file to commit'
      : 'Nothing to commit. Branch is up to date.',
    disabled: true
  }
}
