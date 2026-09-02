import { Flashlight, Loader2, ScrollText, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { Badge } from '../ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '@/lib/utils'
import { openSpotlightTerminalTab } from '@/lib/open-spotlight-terminal-tab'
import { useSpotlightHolderName } from './spotlight-row-hooks'
import { formatTimeAgo } from '@/components/status-bar/tooltip'
import { translate } from '@/i18n/i18n'

/** MVP scope: local (and WSL) git repos only; folders and SSH repos are out. */
export function canHoldSpotlight(
  worktree: Worktree,
  repo: Repo | undefined,
  isFolder: boolean
): boolean {
  return (
    !!repo &&
    !isFolder &&
    !worktree.isMainWorktree &&
    repo.spotlightTestingEnabled === true &&
    !repo.connectionId?.trim()
  )
}

function stopCardActivation(event: React.SyntheticEvent): void {
  // Why: these controls live inside the clickable workspace row; toggling
  // Spotlight must not also activate the workspace.
  event.stopPropagation()
}

/** Per-workspace Spotlight toggle: hover-revealed when idle, illuminated and
 *  always visible while this workspace holds the Spotlight. */
export function SpotlightQuickAction({
  worktree,
  repo
}: {
  worktree: Worktree
  repo: Repo
}): React.JSX.Element | null {
  const activateSpotlight = useAppStore((s) => s.activateSpotlight)
  const deactivateSpotlight = useAppStore((s) => s.deactivateSpotlight)
  // Why useShallow + a per-row view: every row of the repo subscribes to the
  // spotlight state, which main replaces twice per debounced sync. Selecting a
  // shallow-equal view keyed on THIS worktree means non-holder rows compute a
  // stable { held:false, ... } and skip re-rendering on sync churn.
  const view = useAppStore(
    useShallow((s) => {
      const st = s.spotlightByRepo?.[repo.id]
      if (!st) {
        return { held: false, active: false, syncing: false, lastSyncAt: null, errorMsg: null }
      }
      const held = st.holderWorktreeId === worktree.id
      return {
        held,
        active: true,
        syncing: held && st.status === 'syncing',
        lastSyncAt: held ? st.lastSyncAt : null,
        errorMsg: held ? (st.lastError?.message ?? null) : null
      }
    })
  )
  const holderName = useSpotlightHolderName(repo.id)

  const heldHere = view.held
  const syncing = view.syncing
  const syncError = view.errorMsg

  const tooltip = syncing
    ? translate('auto.components.sidebar.WorktreeCardSpotlightControls.syncing', 'Syncing…')
    : syncError
      ? `${translate(
          'auto.components.sidebar.WorktreeCardSpotlightControls.syncBroken',
          'Spotlight sync is failing:'
        )} ${syncError}`
      : heldHere
        ? `${translate(
            'auto.components.sidebar.WorktreeCardSpotlightControls.activeHere',
            'Spotlight on — this workspace mirrors to the project root. Click to turn off.'
          )}${
            view.lastSyncAt
              ? ` ${translate(
                  'auto.components.sidebar.WorktreeCardSpotlightControls.lastSynced',
                  'Last synced {{when}}.'
                ).replace('{{when}}', formatTimeAgo(view.lastSyncAt))}`
              : ''
          }`
        : view.active
          ? translate(
              'auto.components.sidebar.WorktreeCardSpotlightControls.takeover',
              'Take the Spotlight from "{{holder}}" — the project root will mirror this workspace instead.'
            ).replace('{{holder}}', holderName ?? '…')
          : translate(
              'auto.components.sidebar.WorktreeCardSpotlightControls.activate',
              'Spotlight this workspace — mirror its changes onto the project root for testing.'
            )

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    stopCardActivation(event)
    if (syncing) {
      return
    }
    if (heldHere) {
      void deactivateSpotlight(repo.id)
      return
    }
    // activateSpotlight opens/adopts the repo's server terminal on success.
    void activateSpotlight(repo.id, worktree.id)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-workspace-board-preserve-open=""
          onPointerDown={stopCardActivation}
          onClick={handleClick}
          disabled={syncing}
          aria-label={tooltip}
          aria-pressed={heldHere}
          className={cn(
            'inline-flex size-4 items-center justify-center rounded bg-transparent transition-colors transition-opacity',
            heldHere || syncing
              ? 'opacity-100'
              : 'opacity-0 group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100',
            syncError
              ? 'text-destructive hover:bg-destructive/10'
              : heldHere
                ? 'text-amber-400 hover:bg-amber-500/10'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:text-foreground'
          )}
        >
          {syncing && heldHere ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Flashlight className="size-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-72">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** Shown on the primary-worktree row while Spotlight is active. The chip is
 *  the one-click jump to the repo's server terminal; the small × next to it
 *  turns Spotlight off and restores the root. */
export function SpotlightPrimaryBadge({ repo }: { repo: Repo }): React.JSX.Element | null {
  const deactivateSpotlight = useAppStore((s) => s.deactivateSpotlight)
  // Narrow primitive selects so the primary row re-renders only on real state
  // transitions, not on every sync's lastSyncAt bump.
  const active = useAppStore((s) => Boolean(s.spotlightByRepo?.[repo.id]))
  const syncing = useAppStore((s) => s.spotlightByRepo?.[repo.id]?.status === 'syncing')
  const holderName = useSpotlightHolderName(repo.id)

  if (!active) {
    return null
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-workspace-board-preserve-open=""
            onPointerDown={stopCardActivation}
            onClick={(event) => {
              stopCardActivation(event)
              openSpotlightTerminalTab({ repoId: repo.id, reveal: true })
            }}
            aria-label={translate(
              'auto.components.sidebar.WorktreeCardSpotlightControls.primaryBadgeAria',
              'Spotlight is on. Click to open the server terminal.'
            )}
            className="shrink-0"
          >
            <Badge
              variant="outline"
              className="h-[16px] gap-0.5 px-1.5 text-[10px] font-medium uppercase tracking-wider rounded shrink-0 leading-none text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/15"
            >
              {syncing ? (
                <Loader2 className="size-2.5 animate-spin" />
              ) : (
                <Flashlight className="size-2.5" />
              )}
              {translate(
                'auto.components.sidebar.WorktreeCardSpotlightControls.badgeLabel',
                'spotlight'
              )}
            </Badge>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-72">
          {translate(
            'auto.components.sidebar.WorktreeCardSpotlightControls.primaryBadgeTooltip',
            'The project root mirrors "{{holder}}". Click to open the server terminal.'
          ).replace('{{holder}}', holderName ?? '…')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex size-4 items-center justify-center opacity-0 transition-opacity',
              'group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100',
              'text-muted-foreground'
            )}
          >
            <ScrollText className="size-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-72">
          {translate(
            'auto.components.sidebar.WorktreeCardSpotlightControls.agentLogs',
            'Agents in every workspace can read the server logs: .orca/spotlight.log (env var ORCA_SPOTLIGHT_LOG).'
          )}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-workspace-board-preserve-open=""
            onPointerDown={stopCardActivation}
            onClick={(event) => {
              stopCardActivation(event)
              if (!syncing) {
                void deactivateSpotlight(repo.id)
              }
            }}
            disabled={syncing}
            aria-label={translate(
              'auto.components.sidebar.WorktreeCardSpotlightControls.turnOff',
              'Turn off Spotlight and restore the project root'
            )}
            className={cn(
              'inline-flex size-4 items-center justify-center rounded bg-transparent opacity-0 transition-colors transition-opacity',
              'group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100',
              'text-muted-foreground hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-300 disabled:opacity-50'
            )}
          >
            <X className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {translate(
            'auto.components.sidebar.WorktreeCardSpotlightControls.turnOff',
            'Turn off Spotlight and restore the project root'
          )}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
