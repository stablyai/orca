import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Settings as SettingsIcon, Terminal as TerminalIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PopoverContent } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from '@/components/ui/command'
import { AgentIcon } from '@/lib/agent-catalog'
import { useQuickLaunchAgents } from '@/components/tab-bar/QuickLaunchButton'
import { cn } from '@/lib/utils'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { SessionGridFilter } from '../../../../shared/session-grid-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  sessionGridBranchMeta,
  sessionGridWorktreeLabel,
  type SessionGridWorktreeCatalog,
  type SessionGridWorktreeEntry
} from './session-grid-worktree-catalog'
import {
  launchSessionGridTab,
  mountSessionGridLaunchInBackground
} from './session-grid-launch-actions'
import { translate } from '@/i18n/i18n'

/** Which workspace a launch goes to without asking: the filtered one, else the active one. */
export function sessionGridDirectLaunchTarget(
  activeFilter: SessionGridFilter,
  defaultWorktreeId?: string
): string | null {
  return activeFilter !== 'all' ? activeFilter : (defaultWorktreeId ?? null)
}

type LaunchGroup = { key: string; heading: string; entries: SessionGridWorktreeEntry[] }

/**
 * Step one's rows. Workspaces already on the grid come first — the active one leading —
 * because "another session where I am" is the common case; every other workspace follows,
 * grouped by project the way the sidebar groups them. Nothing is listed twice, so a search
 * never shows one workspace under two headings.
 */
function buildLaunchGroups(
  worktreeCatalog: SessionGridWorktreeCatalog,
  gridWorktreeIds: readonly string[],
  defaultWorktreeId: string | undefined
): LaunchGroup[] {
  const listed = new Set<string>()
  const inGrid: SessionGridWorktreeEntry[] = []
  const leadIds = defaultWorktreeId
    ? [defaultWorktreeId, ...gridWorktreeIds.filter((id) => id !== defaultWorktreeId)]
    : gridWorktreeIds
  for (const id of leadIds) {
    for (const entry of worktreeCatalog.entriesByWorktreeId.get(id) ?? []) {
      const identity = composeWorktreeHostIdentity(entry.executionHostId, id)
      if (!listed.has(identity)) {
        inGrid.push(entry)
        listed.add(identity)
      }
    }
  }
  const groups: LaunchGroup[] = []
  if (inGrid.length > 0) {
    groups.push({
      key: 'in-grid',
      heading: translate(
        'auto.components.session.grid.SessionGridLaunchPicker.inThisGrid',
        'In this grid'
      ),
      entries: inGrid
    })
  }
  for (const repo of worktreeCatalog.byRepo) {
    const entries = repo.worktrees.filter(
      (entry) => !listed.has(composeWorktreeHostIdentity(entry.executionHostId, entry.worktreeId))
    )
    if (entries.length > 0) {
      groups.push({ key: repo.repoId, heading: repo.repoName, entries })
    }
  }
  return groups
}

/** The launch surface, shared by the toolbar's +, every vacant slot and the empty page. */
export type SessionGridLaunchPopoverProps = {
  activeFilter: SessionGridFilter
  defaultWorktreeId?: string
  worktreeCatalog: SessionGridWorktreeCatalog
  /** Workspaces with a card on the grid, in grid order; the picker leads with them. */
  gridWorktreeIds: readonly string[]
  /** Called once a launch went out, so the owner can close the popover. */
  onDone: () => void
  align?: 'center' | 'start' | 'end'
  sideOffset?: number
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * Two steps in one popover: where, then what. The first step is a searchable list because
 * the workspace count is unbounded; the second lists what that workspace's host can launch,
 * and only probes that host once the user is there — the same lazy detection the old
 * submenu had, so opening the picker never sondes every host at once.
 */
export function SessionGridLaunchPopoverContent({
  activeFilter,
  defaultWorktreeId,
  worktreeCatalog,
  gridWorktreeIds,
  onDone,
  align = 'center',
  sideOffset = 8,
  onCloseAutoFocus
}: SessionGridLaunchPopoverProps): React.JSX.Element {
  const [picked, setPicked] = useState<SessionGridWorktreeEntry | null>(null)
  // A filtered grid already names the workspace: skip straight to what to launch there.
  const direct = useMemo<SessionGridWorktreeEntry | null>(() => {
    if (activeFilter === 'all') {
      return null
    }
    const entries = worktreeCatalog.entriesByWorktreeId.get(activeFilter) ?? []
    return entries.length > 1 ? null : (entries[0] ?? placeholderEntry(activeFilter))
  }, [activeFilter, worktreeCatalog])
  const target = direct ?? picked
  const groups = useMemo(() => {
    if (direct) {
      return []
    }
    const groups = buildLaunchGroups(worktreeCatalog, gridWorktreeIds, defaultWorktreeId)
    return activeFilter === 'all'
      ? groups
      : groups
          .map((group) => ({
            ...group,
            entries: group.entries.filter((entry) => entry.worktreeId === activeFilter)
          }))
          .filter((group) => group.entries.length > 0)
  }, [direct, activeFilter, worktreeCatalog, gridWorktreeIds, defaultWorktreeId])
  const goBack = useCallback(() => setPicked(null), [])

  return (
    <PopoverContent
      align={align}
      side="bottom"
      sideOffset={sideOffset}
      className="w-72 p-0"
      {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
      onOpenAutoFocus={(event) => {
        // Radix would focus the content wrapper; the search box (or the list) is the real target.
        event.preventDefault()
        const content = event.currentTarget
        if (content instanceof HTMLElement) {
          const focusTarget =
            content.querySelector<HTMLElement>('[data-slot="command-input"]') ??
            content.querySelector<HTMLElement>('[data-slot="command"]')
          focusTarget?.focus()
        }
      }}
    >
      {target ? (
        <SessionGridLaunchTargetList
          entry={target}
          onBack={direct ? undefined : goBack}
          onDone={onDone}
        />
      ) : (
        <Command>
          <CommandInput
            placeholder={translate(
              'auto.components.session.grid.SessionGridLaunchPicker.search',
              'Search workspaces…'
            )}
            className="h-8 text-xs"
          />
          <CommandList className="max-h-80">
            <CommandEmpty>
              {translate(
                'auto.components.session.grid.SessionGridLaunchPicker.empty',
                'No workspace matches'
              )}
            </CommandEmpty>
            {groups.map((group, index) => (
              <React.Fragment key={group.key}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={group.heading}>
                  {group.entries.map((entry) => {
                    const branch = sessionGridBranchMeta(entry)
                    // Why host-qualified: two hosts publish the same `worktreeId`, and one shared
                    // key collapsed their two rows into one (store/worktree-repo-index.ts:29).
                    const identity = composeWorktreeHostIdentity(
                      entry.executionHostId,
                      entry.worktreeId
                    )
                    return (
                      <CommandItem
                        key={identity}
                        value={identity}
                        keywords={[entry.repoName, entry.worktreeName, branch ?? '']}
                        data-testid="session-grid-launch-workspace"
                        data-execution-host={entry.executionHostId}
                        onSelect={() => setPicked(entry)}
                        className="text-xs"
                      >
                        <span className="truncate font-medium">
                          {group.key === 'in-grid' && entry.worktreeName !== entry.repoName ? (
                            <span className="font-normal text-muted-foreground">
                              {entry.repoName} /{' '}
                            </span>
                          ) : null}
                          {entry.worktreeName}
                        </span>
                        {branch ? (
                          <span className="truncate text-[11px] text-muted-foreground">
                            · {branch}
                          </span>
                        ) : null}
                        {entry.hostLabel ? (
                          <span className="ml-auto truncate pl-2 text-[10px] text-muted-foreground">
                            {entry.hostLabel}
                          </span>
                        ) : null}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </React.Fragment>
            ))}
          </CommandList>
        </Command>
      )}
    </PopoverContent>
  )
}

/** A workspace the catalogs no longer know; the launch still has a worktree id to go to. */
function placeholderEntry(worktreeId: string): SessionGridWorktreeEntry {
  const name = sessionGridWorktreeLabel(undefined)
  return {
    worktreeId,
    worktreeName: name,
    repoId: worktreeId,
    repoName: name,
    path: '',
    label: name,
    hostKind: 'local',
    executionHostId: 'local' as ExecutionHostId
  }
}

/**
 * Step two: what one workspace can start. The user's default agent leads, so Enter twice
 * from the + is "the usual, where I am". `activate={false}` keeps the grid in front — the
 * launch goes to a workspace the user is not standing in.
 */
export function SessionGridLaunchTargetList({
  entry,
  onBack,
  onDone
}: {
  entry: SessionGridWorktreeEntry
  /** Present when the user came through step one; absent when the grid named the workspace. */
  onBack?: () => void
  onDone: () => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const onLaunched = useCallback(
    (tabId: string) => {
      mountSessionGridLaunchInBackground(entry.worktreeId, tabId)
      onDone()
    },
    [entry.worktreeId, onDone]
  )
  const launch = useQuickLaunchAgents({
    worktreeId: entry.worktreeId,
    executionHostId: entry.executionHostId,
    onLaunched,
    launchSource: 'session_grid',
    activate: false
  })
  // cmdk reads arrow keys off its root, and step two has no input to hold focus.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])
  const launchShell = useCallback(() => {
    launchSessionGridTab(entry.worktreeId, entry.executionHostId)
    onDone()
  }, [entry.worktreeId, entry.executionHostId, onDone])
  const launchAgent = useCallback((agent: TuiAgent) => launch.runLaunch(agent), [launch])
  const emptyLabel =
    launch.detectedIds && launch.detectedIds.length > 0
      ? translate(
          'auto.components.session.grid.SessionGridLaunchPicker.noEnabled',
          'No enabled agents'
        )
      : translate(
          'auto.components.session.grid.SessionGridLaunchPicker.noDetected',
          'No agents detected'
        )

  return (
    <Command
      ref={rootRef}
      tabIndex={-1}
      data-testid="session-grid-launch-targets"
      data-execution-host={entry.executionHostId}
      onKeyDown={(event) => {
        if (onBack && (event.key === 'ArrowLeft' || event.key === 'Backspace')) {
          event.preventDefault()
          onBack()
        }
      }}
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-xs text-muted-foreground">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={translate(
              'auto.components.session.grid.SessionGridLaunchPicker.back',
              'Back to workspaces'
            )}
            className="-ml-1 inline-flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" />
          </button>
        ) : null}
        <span className="truncate">
          {translate(
            'auto.components.session.grid.SessionGridLaunchPicker.launchIn',
            'Launch in {{value0}}',
            { value0: entry.label }
          )}
        </span>
        {entry.hostLabel ? (
          <span className="ml-auto truncate pl-2 text-[10px]">{entry.hostLabel}</span>
        ) : null}
      </div>
      <CommandList>
        <CommandGroup>
          {launch.agents.length === 0 ? (
            <CommandItem disabled value="no-agents" className="text-xs text-muted-foreground">
              {emptyLabel}
            </CommandItem>
          ) : null}
          {launch.agents.map((agent) => {
            const label = launch.labelFor(agent)
            const isDefault = launch.defaultAgent !== 'blank' && agent === launch.defaultAgent
            return (
              <CommandItem
                key={agent}
                value={agent}
                keywords={[label]}
                data-testid="session-grid-launch-agent"
                data-agent={agent}
                onSelect={() => launchAgent(agent)}
                className="text-xs font-medium"
              >
                <AgentIcon agent={agent} size={14} />
                <span className="flex-1 truncate">{label}</span>
                {isDefault ? (
                  <Badge
                    variant="outline"
                    className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                  >
                    {translate(
                      'auto.components.session.grid.SessionGridLaunchPicker.default',
                      'Default'
                    )}
                  </Badge>
                ) : null}
                {isDefault && launch.newAgentShortcut ? (
                  <CommandShortcut>{launch.newAgentShortcut}</CommandShortcut>
                ) : null}
              </CommandItem>
            )
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup>
          <CommandItem
            value="terminal-shell"
            data-testid="session-grid-launch-shell"
            onSelect={launchShell}
            className="text-xs"
          >
            <TerminalIcon className={cn('size-3.5 text-muted-foreground')} />
            {translate(
              'auto.components.session.grid.SessionGridLaunchPicker.terminalShell',
              'Terminal Shell'
            )}
          </CommandItem>
          <CommandItem
            value="agent-settings"
            onSelect={launch.openAgentSettings}
            className="text-xs text-muted-foreground"
          >
            <SettingsIcon className="size-3.5" />
            {translate(
              'auto.components.session.grid.SessionGridLaunchPicker.agentSettings',
              'Agent settings…'
            )}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
