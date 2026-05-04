import type { GitUpstreamStatus } from '../../../../shared/types'

// Why: this module owns the pure state-machine logic for the Source Control
// primary action (split button) and its chevron dropdown. Keeping the logic
// outside the React component makes it straightforward to unit-test each row
// of the priority table without spinning up a renderer.

export type PrimaryActionKind =
  | 'commit'
  | 'commit_push'
  | 'commit_sync'
  | 'commit_publish'
  | 'push'
  | 'pull'
  | 'sync'
  | 'publish'

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
 *   4. Has staged files + message → a "Commit & X" compound.
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
    // Why: when the candidate label is a Commit variant, a generic "remote
    // operation in progress" tooltip mismatches the visible label. Surface a
    // tooltip that tells the user the commit will wait, keeping the label and
    // the explanation consistent.
    const isCommitKind = candidate.kind.startsWith('commit')
    return {
      ...candidate,
      title: isCommitKind
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

  // 4. Has staged files + message → compound commit actions (or plain commit
  //    when we don't yet know the remote state).
  if (hasStaged && hasMessage) {
    if (!upstreamStatus) {
      // Why: upstream status hasn't resolved yet. Fall back to a plain commit
      // so we don't promise a remote action ("Commit & Publish") that might
      // be wrong once the real status lands.
      return {
        kind: 'commit',
        label: 'Commit',
        title: 'Commit staged changes',
        disabled: false
      }
    }
    if (!upstreamStatus.hasUpstream) {
      return {
        kind: 'commit_publish',
        label: 'Commit & Publish',
        title: 'Commit staged changes and publish this branch',
        disabled: false
      }
    }
    if (upstreamStatus.behind > 0) {
      return {
        kind: 'commit_sync',
        label: 'Commit & Sync',
        title: `Commit, then ${describeSyncCounts(upstreamStatus.ahead, upstreamStatus.behind).toLowerCase()}`,
        disabled: false
      }
    }
    return {
      kind: 'commit_push',
      label: 'Commit & Push',
      title: 'Commit staged changes and push to remote',
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

export type DropdownActionKind =
  | 'commit'
  | 'commit_push'
  | 'commit_sync'
  | 'push'
  | 'pull'
  | 'sync'
  | 'fetch'
  | 'publish'

export type DropdownItem = {
  kind: DropdownActionKind
  label: string
  title: string
  disabled: boolean
}

export type DropdownSeparator = { kind: 'separator' }

export type DropdownEntry = DropdownItem | DropdownSeparator

/**
 * Resolve the chevron dropdown items. Every item is always rendered so the
 * menu shape stays stable across states; inapplicable rows are disabled
 * with a tooltip reason rather than hidden.
 */
export function resolveDropdownItems(inputs: PrimaryActionInputs): DropdownEntry[] {
  const {
    stagedCount,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    upstreamStatus
  } = inputs

  const hasStaged = stagedCount > 0
  const hasUpstream = upstreamStatus?.hasUpstream ?? false
  const ahead = upstreamStatus?.ahead ?? 0
  const behind = upstreamStatus?.behind ?? 0

  // Why: any in-flight commit or remote operation should lock the whole menu.
  // A running push shouldn't let a second pull/sync click queue up behind it
  // on a stale status snapshot.
  const globalBusy = isCommitting || isRemoteOperationActive

  const commitDisabledReason = (() => {
    if (hasUnresolvedConflicts) {
      return 'Resolve conflicts before committing'
    }
    if (!hasStaged) {
      return 'Stage at least one file to commit'
    }
    if (!hasMessage) {
      return 'Enter a commit message to commit'
    }
    return null
  })()
  const canCommit = !globalBusy && commitDisabledReason === null
  const commitItem: DropdownItem = {
    kind: 'commit',
    label: 'Commit',
    title: commitDisabledReason ?? 'Commit staged changes',
    disabled: !canCommit
  }

  // Why: when the branch has no upstream, the primary button surfaces
  // "Commit & Publish" as a one-click path. Point the dropdown at that
  // compound action instead of contradicting it with a "publish first"
  // instruction that ignores the offered shortcut.
  const commitPushTitle = !hasUpstream
    ? 'Use Commit & Publish to publish and push in one step'
    : (commitDisabledReason ?? 'Commit staged changes and push')
  const commitPushItem: DropdownItem = {
    kind: 'commit_push',
    label: formatCountLabel('Commit & Push', ahead),
    title: commitPushTitle,
    disabled: globalBusy || !hasUpstream || commitDisabledReason !== null
  }

  const commitSyncTitle = (() => {
    if (!hasUpstream) {
      // Why: same reasoning as commitPushTitle — stay consistent with the
      // primary's Commit & Publish offer rather than telling the user to
      // publish first.
      return 'Use Commit & Publish, then sync'
    }
    if (behind === 0) {
      return 'Nothing to pull — use Commit & Push instead'
    }
    return commitDisabledReason ?? `Commit, then ${describeSyncCounts(ahead, behind).toLowerCase()}`
  })()
  const commitSyncItem: DropdownItem = {
    kind: 'commit_sync',
    label: formatSyncLabel('Commit & Sync', ahead, behind),
    title: commitSyncTitle,
    disabled: globalBusy || !hasUpstream || behind === 0 || commitDisabledReason !== null
  }

  const pushItem: DropdownItem = {
    kind: 'push',
    label: formatCountLabel('Push', ahead),
    title: !hasUpstream
      ? 'Publish the branch first to push commits'
      : ahead === 0
        ? 'Nothing to push'
        : describePushCount(ahead),
    disabled: globalBusy || !hasUpstream || ahead === 0
  }

  const pullItem: DropdownItem = {
    kind: 'pull',
    label: formatCountLabel('Pull', behind),
    title: !hasUpstream
      ? 'Publish the branch first to pull commits'
      : behind === 0
        ? 'Nothing to pull'
        : describePullCount(behind),
    disabled: globalBusy || !hasUpstream || behind === 0
  }

  const syncItem: DropdownItem = {
    kind: 'sync',
    label: formatSyncLabel('Sync', ahead, behind),
    title: !hasUpstream
      ? 'Publish the branch first to sync commits'
      : ahead === 0 && behind === 0
        ? 'Branch is up to date'
        : describeSyncCounts(ahead, behind),
    disabled: globalBusy || !hasUpstream || (ahead === 0 && behind === 0)
  }

  const fetchItem: DropdownItem = {
    kind: 'fetch',
    label: 'Fetch',
    title: !hasUpstream
      ? 'Publish the branch first to fetch from remote'
      : 'Fetch from remote without merging',
    disabled: globalBusy || !hasUpstream
  }

  const publishItem: DropdownItem = {
    kind: 'publish',
    label: 'Publish Branch',
    title: hasUpstream ? 'Branch is already published' : 'Publish this branch to origin',
    disabled: globalBusy || hasUpstream
  }

  return [
    commitItem,
    commitPushItem,
    commitSyncItem,
    { kind: 'separator' },
    pushItem,
    pullItem,
    syncItem,
    fetchItem,
    publishItem
  ]
}

function formatCountLabel(base: string, count: number): string {
  return count > 0 ? `${base} (${count})` : base
}

function formatSyncLabel(base: string, ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) {
    return base
  }
  return `${base} (↓${behind} ↑${ahead})`
}
