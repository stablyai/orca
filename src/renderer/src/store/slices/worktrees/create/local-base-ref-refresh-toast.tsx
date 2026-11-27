import { useId, useRef, useState } from 'react'
import { ChevronRight, Info, TriangleAlertIcon, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useToastHeightChange } from '@/components/ui/toast-height-change'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getKeepLocalMainUpToDateTitle } from '@/components/settings/source-control/keep-local-main-up-to-date-setting'
import { translate } from '@/i18n/i18n'
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

// Why: the raw Git guidance (incl. the owner worktree path) stays behind the title so the card reads in one line.
function LocalBaseRefNotUpdatedCard({
  title,
  reason,
  detail,
  disableLabel,
  disableTooltip,
  closeLabel,
  onDisable,
  onClose,
  onResize
}: {
  title: string
  reason: string
  detail: string
  disableLabel: string
  disableTooltip: string
  closeLabel: string
  onDisable: () => void
  onClose: () => void
  onResize: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  useToastHeightChange(cardRef, onResize)
  return (
    <div
      ref={cardRef}
      className="flex w-[var(--width)] flex-col gap-1 rounded-[var(--radius)] border border-[var(--notice-border)] bg-[var(--notice-surface)] p-3 text-[13px] leading-5 text-popover-foreground shadow-notice"
    >
      <div className="flex items-center gap-2">
        <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={detailId}
        >
          <span className="truncate" title={title}>
            {title}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={`size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5"
          data-close-button
          aria-label={closeLabel}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="flex items-center gap-2 pl-6">
        <p className="min-w-0 flex-1 truncate text-popover-foreground/80" title={reason}>
          {reason}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="secondary" size="xs-notice" onClick={onDisable}>
              {disableLabel}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {disableTooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      {open ? (
        <p
          id={detailId}
          className="mt-1 select-text whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
        >
          {detail}
        </p>
      ) : null}
    </div>
  )
}

function stopRefreshingLocalBaseRef(
  id: string,
  localBranch: string,
  updateSettings: AppState['updateSettings']
): void {
  void Promise.resolve(updateSettings({ refreshLocalBaseRefOnWorktreeCreate: false }))
    .then(() => {
      toast.dismiss(id)
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
      toast.dismiss(toastId)
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
  // Why: one id per repo and branch because creates toward one target share a run, so its result is one fact, not one per create.
  const id = `local-base-ref-refresh-failed:${createdWorktree?.repoId ?? 'unknown'}:${result.localBranch}`
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
        onClick={() => stopRefreshingLocalBaseRef(id, result.localBranch, updateSettings)}
      >
        {translate('auto.store.slices.worktrees.localBaseRefRefreshTurnOff', 'Disable Check')}
      </Button>
      {result.shallowHistory && createdWorktree && runnableCommand ? (
        <Button
          size="sm"
          onClick={() =>
            runUnshallowInNewTerminalTab(id, createdWorktree.id, executionHostId, runnableCommand)
          }
        >
          {translate('auto.store.slices.worktrees.localBaseRefUnshallow', 'Unshallow')}
        </Button>
      ) : null}
    </>
  )

  // Why re-shown on resize: opening Details grows the card, and sonner only measures on show.
  const onResize = (): void => {
    if (toast.getToasts().some((entry) => entry.id === id)) {
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
            onDisable={() => stopRefreshingLocalBaseRef(id, result.localBranch, updateSettings)}
            onClose={() => toast.dismiss(id)}
            onResize={onResize}
          />
        ),
        { id, duration: Infinity, closeButton: false, dismissible: true }
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
      duration: Infinity,
      dismissible: true
    })
  }
  show()
}
