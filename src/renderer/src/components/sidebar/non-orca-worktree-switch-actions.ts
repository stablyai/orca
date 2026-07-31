import type {
  DetectedWorktreeListResult,
  ExternalWorktreeVisibility,
  Repo
} from '../../../../shared/types'
import { mergeExternalWorktreeInboxPaths } from '../../../../shared/external-worktree-inbox'
import { translate } from '@/i18n/i18n'
import {
  hiddenPathsForKind,
  importedPathsAfterHidingKind,
  type NonOrcaWorktreeKind
} from './non-orca-worktree-visibility-candidates'

export type NonOrcaWorktreeSwitchState = {
  pending: boolean
  error: string | null
}

type RepoVisibilityUpdate = Partial<
  Pick<
    Repo,
    | 'externalWorktreeVisibility'
    | 'agentWorktreeVisibility'
    | 'importedExternalWorktreePaths'
    | 'externalWorktreeInboxBaselinePaths'
    | 'externalWorktreeVisibilityPromptDismissedAt'
  >
> & {
  externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
}

type NonOrcaWorktreeSwitchDeps = {
  repo: Repo
  detected: DetectedWorktreeListResult | undefined
  kind: NonOrcaWorktreeKind
  next: ExternalWorktreeVisibility
  previous: ExternalWorktreeVisibility
  setSwitchState: (state: NonOrcaWorktreeSwitchState | null) => void
  updateRepo: (projectId: string, updates: RepoVisibilityUpdate) => Promise<boolean>
  fetchWorktrees: (
    projectId: string,
    options?: { requireAuthoritative?: boolean }
  ) => Promise<boolean>
}

function switchFailureMessage(kind: NonOrcaWorktreeKind): string {
  return kind === 'agent-scratch'
    ? translate(
        'auto.components.sidebar.nonOrcaWorktreeSwitchActions.b8f2093ea4',
        'Could not change agent scratch worktree visibility. Try again.'
      )
    : translate(
        'auto.components.sidebar.nonOrcaWorktreeSwitchActions.b52d8f0a61',
        'Could not change worktree visibility. Try again.'
      )
}

function kindVisibility(
  kind: NonOrcaWorktreeKind,
  visibility: ExternalWorktreeVisibility
): RepoVisibilityUpdate {
  return kind === 'agent-scratch'
    ? { agentWorktreeVisibility: visibility }
    : { externalWorktreeVisibility: visibility }
}

export async function setNonOrcaWorktreeKindVisibility(
  args: NonOrcaWorktreeSwitchDeps
): Promise<void> {
  const failure = switchFailureMessage(args.kind)
  // Why: hiding purges this kind's imports and records its decision, both read off the
  // detected list. A fallback snapshot lists nothing and misfiles what it does list, so
  // refuse rather than purge the wrong paths against an empty list.
  if (args.next === 'hide' && args.detected?.authoritative !== true) {
    args.setSwitchState({ pending: false, error: failure })
    return
  }
  const previousImportedPaths = [...(args.repo.importedExternalWorktreePaths ?? [])]
  const previousBaselinePaths = [...(args.repo.externalWorktreeInboxBaselinePaths ?? [])]
  const previousSuppressedAt = args.repo.externalWorktreeDiscoverySuppressedAt
  args.setSwitchState({ pending: true, error: null })
  const updated = await args.updateRepo(args.repo.id, {
    ...kindVisibility(args.kind, args.next),
    // Why: an explicit import outranks the switch, so hiding a kind has to drop that
    // kind's imports or those rows would survive the switch that was just set, and the
    // paths it hides become decided, or the inbox re-announces them at once.
    ...(args.next === 'hide'
      ? {
          importedExternalWorktreePaths: importedPathsAfterHidingKind(
            args.repo,
            args.kind,
            args.detected
          ),
          externalWorktreeInboxBaselinePaths: mergeExternalWorktreeInboxPaths(
            args.repo.externalWorktreeInboxBaselinePaths,
            hiddenPathsForKind(args.detected, args.kind, args.repo)
          )
        }
      : {}),
    // Why: null is the transport sentinel for clearing, and showing this kind again
    // should re-enable the inbox after an earlier opt-out.
    ...(args.next === 'show' && args.kind === 'other'
      ? { externalWorktreeDiscoverySuppressedAt: null }
      : {})
  })
  if (!updated) {
    args.setSwitchState({ pending: false, error: failure })
    return
  }
  const refreshed = await args.fetchWorktrees(args.repo.id, { requireAuthoritative: true })
  if (!refreshed) {
    // Why: a stale list must not read as a successful flip, so every field the forward
    // write touched goes back, including a suppression it may have cleared.
    await args.updateRepo(args.repo.id, {
      ...kindVisibility(args.kind, args.previous),
      importedExternalWorktreePaths: previousImportedPaths,
      externalWorktreeInboxBaselinePaths: previousBaselinePaths,
      ...(previousSuppressedAt === undefined
        ? {}
        : { externalWorktreeDiscoverySuppressedAt: previousSuppressedAt })
    })
    args.setSwitchState({ pending: false, error: failure })
    return
  }
  // Why: recorded only once the flip stuck, since there is no transport sentinel to
  // un-dismiss, and a rolled-back attempt must leave the first-run card in place.
  if (
    args.kind === 'other' &&
    args.repo.externalWorktreeVisibilityPromptDismissedAt === undefined
  ) {
    await args.updateRepo(args.repo.id, {
      externalWorktreeVisibilityPromptDismissedAt: Date.now()
    })
  }
  args.setSwitchState(null)
}
