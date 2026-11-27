import { Info } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getKeepLocalMainUpToDateTitle } from '@/components/settings/source-control/keep-local-main-up-to-date-setting'
import { translate } from '@/i18n/i18n'
import { LocalBaseRefNotUpdatedCard } from './local-base-ref-not-updated-card'
import {
  dismissLocalBaseRefToast,
  isLocalBaseRefToastOpen,
  openLocalBaseRefToastId,
  retireLocalBaseRefToast
} from './local-base-ref-toast-lifecycle'
import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { LocalBaseRefRefreshResult } from '../../../../../../shared/worktree/base-refs/base-ref-drift-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

export function localBaseRefRefreshFailureDetail(result: LocalBaseRefRefreshResult): string {
  const ownerWorktreePath = result.ownerWorktreePath?.trim()
  switch (result.status) {
    case 'skipped_dirty_worktree':
      // Create already succeeded — guide cleanup + manual base update, not "try again".
      return ownerWorktreePath
        ? translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailDirtyNamed',
            'The worktree at {{value0}} (where local {{value1}} is checked out) has uncommitted changes. Commit, stash, or discard those changes, then update local {{value1}} manually.',
            { value0: ownerWorktreePath, value1: result.localBranch }
          )
        : translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailDirty',
            'The worktree where local {{value0}} is checked out has uncommitted changes. Commit, stash, or discard those changes, then update local {{value0}} manually.',
            { value0: result.localBranch }
          )
    case 'skipped_not_fast_forward':
      return translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailNotFastForward',
        'Local {{value0}} does not exist or cannot be fast-forwarded cleanly from the remote base. Check for local-only commits before updating it manually.',
        { value0: result.localBranch }
      )
    case 'skipped_error':
      return translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailError',
        'Git returned an error while updating local {{value0}}. Check the repo for locked refs or unusual worktree state, then update local {{value0}} manually.',
        { value0: result.localBranch }
      )
    case 'updated':
      return ''
  }
}

// Why an allowlist, not quoting: the tab's shell may be bash, PowerShell, cmd, or WSL, and Git allows `;` in remote names.
const SHELL_SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `origin/main` → `origin`; undefined when the base does not end in the local branch name. */
function remoteNameForBaseRef(result: LocalBaseRefRefreshResult): string | undefined {
  const shortBaseRef = result.baseRef.replace(/^refs\/remotes\//, '')
  const suffix = `/${result.localBranch}`
  return shortBaseRef.endsWith(suffix) && shortBaseRef.length > suffix.length
    ? shortBaseRef.slice(0, -suffix.length)
    : undefined
}

function unshallowCommand(result: LocalBaseRefRefreshResult): string {
  const remote = remoteNameForBaseRef(result)
  return remote ? `git fetch --unshallow ${remote}` : 'git fetch --unshallow'
}

/** The command only when every interpolated part is inert in any shell. */
function runnableUnshallowCommand(result: LocalBaseRefRefreshResult): string | undefined {
  const remote = remoteNameForBaseRef(result)
  return remote === undefined || SHELL_SAFE_REMOTE_NAME.test(remote)
    ? unshallowCommand(result)
    : undefined
}

function refreshFailureTitle(result: LocalBaseRefRefreshResult): string {
  if (result.shallowHistory) {
    return translate(
      'auto.store.slices.worktrees.localBaseRefShallowHistoryTitle',
      'Local {{value0}} not updated: shallow clone',
      { value0: result.localBranch }
    )
  }
  return translate('auto.store.slices.worktrees.localBaseRefNotUpdated', '{{value0}} not updated', {
    value0: result.localBranch
  })
}

function refreshFailureReason(result: LocalBaseRefRefreshResult): string {
  switch (result.status) {
    case 'skipped_dirty_worktree':
      return translate(
        'auto.store.slices.worktrees.localBaseRefNotUpdatedDirty',
        'Uncommitted changes in {{value0}}.',
        { value0: result.localBranch }
      )
    case 'skipped_not_fast_forward':
      return translate(
        'auto.store.slices.worktrees.localBaseRefNotUpdatedNotFastForward',
        'Local-only commits on {{value0}}.',
        { value0: result.localBranch }
      )
    case 'skipped_error':
    case 'updated':
      return translate('auto.store.slices.worktrees.localBaseRefNotUpdatedError', 'Git error.')
  }
}

function shallowHistoryDescription(
  result: LocalBaseRefRefreshResult,
  worktreeName: string
): React.ReactNode {
  const explanation = worktreeName
    ? translate(
        'auto.store.slices.worktrees.localBaseRefShallowHistoryNamed',
        '"{{value0}}" was created from {{value1}} and is unaffected. Orca could not also update your local {{value2}} branch because this clone only has recent history, so Git cannot confirm local {{value2}} is just behind. To fix this for every new workspace, run once:',
        { value0: worktreeName, value1: result.baseRef, value2: result.localBranch }
      )
    : translate(
        'auto.store.slices.worktrees.localBaseRefShallowHistory',
        'Your workspace was created from {{value0}} and is unaffected. Orca could not also update your local {{value1}} branch because this clone only has recent history, so Git cannot confirm local {{value1}} is just behind. To fix this for every new workspace, run once:',
        { value0: result.baseRef, value1: result.localBranch }
      )
  return (
    <p className="text-sm leading-5 text-popover-foreground/80">
      {explanation}{' '}
      <code className="rounded bg-accent px-1 py-px font-mono [overflow-wrap:anywhere]">
        {unshallowCommand(result)}
      </code>
    </p>
  )
}

function stopRefreshingLocalBaseRef(
  closeToast: () => void,
  localBranch: string,
  updateSettings: AppState['updateSettings']
): void {
  void Promise.resolve(updateSettings({ refreshLocalBaseRefOnWorktreeCreate: false }))
    .then(() => {
      closeToast()
      toast.success(
        translate(
          'auto.store.slices.worktrees.localBaseRefRefreshTurnedOff',
          'Orca will no longer update local {{value0}}',
          { value0: localBranch }
        ),
        {
          description: translate(
            'auto.store.slices.worktrees.localBaseRefRefreshTurnedOffDescription',
            'Turn it back on in Settings › {{value0}}.',
            { value0: getKeepLocalMainUpToDateTitle() }
          )
        }
      )
    })
    .catch(() => {
      toast.error(
        translate(
          'auto.store.slices.worktrees.localBaseRefRefreshTurnOffFailed',
          'Could not turn off {{value0}}',
          { value0: getKeepLocalMainUpToDateTitle() }
        )
      )
    })
}

function showUnshallowLaunchFailure(command: string): void {
  toast.error(
    translate(
      'auto.store.slices.worktrees.localBaseRefUnshallowFailed',
      'Could not open a terminal for this workspace'
    ),
    {
      description: translate(
        'auto.store.slices.worktrees.localBaseRefUnshallowFailedDescription',
        'Run {{value0}} in a terminal in this repository instead.',
        { value0: command }
      )
    }
  )
}

const unshallowLaunchesInFlight = new Set<string>()

function runUnshallowInNewTerminalTab(
  toastId: string,
  closeToast: () => void,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  command: string
): void {
  // Why: a second click would race the first fetch for Git's shallow lock.
  if (unshallowLaunchesInFlight.has(toastId)) {
    return
  }
  unshallowLaunchesInFlight.add(toastId)
  const settle = (started: boolean): void => {
    unshallowLaunchesInFlight.delete(toastId)
    if (started) {
      closeToast()
    } else {
      showUnshallowLaunchFailure(command)
    }
  }
  // Why lazy: the terminal launchers import the store, which imports this slice.
  void Promise.all([
    import('@/lib/workspace/activation/worktree-activation'),
    import('@/components/terminal/tab-lifecycle/terminal-tab-create')
  ]).then(
    ([{ activateAndRevealWorktree }, { createNewTerminalTab }]) => {
      if (
        !activateAndRevealWorktree(worktreeId, executionHostId ? { executionHostId } : undefined)
      ) {
        settle(false)
        return
      }
      createNewTerminalTab(worktreeId, undefined, { command, onSettled: settle })
    },
    () => settle(false)
  )
}

// Why: sonner's public options omit these, but an in-place variant switch must clear them.
const CLEAR_INFO_TOAST_FIELDS: Record<string, undefined> = { type: undefined }
const CLEAR_CUSTOM_TOAST_FIELDS: Record<string, undefined> = { jsx: undefined }

export function showLocalBaseRefRefreshToast(
  result: LocalBaseRefRefreshResult | undefined,
  createdWorktree: Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'branch' | 'path'> | undefined,
  deps: { updateSettings: AppState['updateSettings']; executionHostId?: ExecutionHostId }
): void {
  const { updateSettings, executionHostId } = deps
  if (!result || result.status === 'updated') {
    return
  }

  const worktreeName = createdWorktree ? resolveWorktreeDisplayName(createdWorktree).trim() : ''
  // Why: one toast per repo and branch because creates toward one target share a run, so its result is one fact, not one per create.
  const target = `local-base-ref-refresh-failed:${createdWorktree?.repoId ?? 'unknown'}:${result.localBranch}`
  const id = openLocalBaseRefToastId(target)
  const onDismiss = (): void => retireLocalBaseRefToast(target, id)
  const closeToast = (): void => dismissLocalBaseRefToast(target, id)
  const runnableCommand = result.shallowHistory ? runnableUnshallowCommand(result) : undefined

  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={translate(
              'auto.store.slices.worktrees.localBaseRefRefreshTurnOffHelp',
              'What Disable Check does'
            )}
            className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-72">
          {translate(
            'auto.store.slices.worktrees.localBaseRefRefreshTurnOffTooltip',
            'Turns off the Orca setting {{value0}}. Orca will stop updating local {{value1}} when you create a workspace, and this warning will stop appearing. New workspaces are unaffected. Turn it back on anytime in Settings › Git.',
            { value0: getKeepLocalMainUpToDateTitle(), value1: result.localBranch }
          )}
        </TooltipContent>
      </Tooltip>
      <Button
        size="sm"
        variant="outline"
        onClick={() => stopRefreshingLocalBaseRef(closeToast, result.localBranch, updateSettings)}
      >
        {translate('auto.store.slices.worktrees.localBaseRefRefreshTurnOff', 'Disable Check')}
      </Button>
      {result.shallowHistory && createdWorktree && runnableCommand ? (
        <Button
          size="sm"
          onClick={() =>
            runUnshallowInNewTerminalTab(
              id,
              closeToast,
              createdWorktree.id,
              executionHostId,
              runnableCommand
            )
          }
        >
          {translate('auto.store.slices.worktrees.localBaseRefUnshallow', 'Unshallow')}
        </Button>
      ) : null}
    </>
  )

  // Why re-shown on resize: opening Details grows the card, and sonner only measures on show.
  const onResize = (): void => {
    if (isLocalBaseRefToastOpen(target, id)) {
      show()
    }
  }
  // Why an arrow: a hoisted function declaration would lose the `result` narrowing.
  const show = (): void => {
    if (!result.shallowHistory) {
      // Why custom: the close and Disable share the card's right edge, which sonner's floating close can't.
      // Infinity so create-time failures aren't buried; the opt-out lives here since the setting is opt-in.
      toast.custom(
        () => (
          <LocalBaseRefNotUpdatedCard
            title={refreshFailureTitle(result)}
            reason={refreshFailureReason(result)}
            detail={localBaseRefRefreshFailureDetail(result)}
            disableLabel={translate(
              'auto.store.slices.worktrees.localBaseRefRefreshDisable',
              'Disable'
            )}
            disableTooltip={translate(
              'auto.store.slices.worktrees.localBaseRefRefreshDisableTooltip',
              'Stop checking {{value0}}',
              { value0: result.localBranch }
            )}
            closeLabel={translate('auto.store.slices.worktrees.localBaseRefClose', 'Close')}
            onDisable={() =>
              stopRefreshingLocalBaseRef(closeToast, result.localBranch, updateSettings)
            }
            onClose={closeToast}
            onResize={onResize}
          />
        ),
        // Why a width on the toast: sonner sizes only styled toasts on wide screens; its narrow-screen width still wins.
        // Why every field: an open toast switches variant in place, and sonner merges updates into it.
        {
          id,
          className: 'w-[var(--width)]',
          description: undefined,
          duration: Infinity,
          closeButton: false,
          dismissible: true,
          onDismiss,
          ...CLEAR_INFO_TOAST_FIELDS
        }
      )
      return
    }
    // Why info, not warning: the workspace was created fine; only the optional local-branch refresh was skipped.
    toast.info(refreshFailureTitle(result), {
      id,
      description: (
        <div className="flex w-full flex-col gap-3">
          {shallowHistoryDescription(result, worktreeName)}
          <div className="flex items-center justify-end gap-2">{actions}</div>
        </div>
      ),
      className: undefined,
      closeButton: undefined,
      duration: Infinity,
      dismissible: true,
      onDismiss,
      ...CLEAR_CUSTOM_TOAST_FIELDS
    })
  }
  show()
}
