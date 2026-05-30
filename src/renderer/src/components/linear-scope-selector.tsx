import { useCallback, useMemo, useState } from 'react'
import { Check, ChevronDown, KeyRound } from 'lucide-react'
import type { LinearTeam, LinearWorkspace, LinearWorkspaceSelection } from '../../../shared/types'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type LinearScopeSelectorProps = {
  workspaces: LinearWorkspace[]
  selectedWorkspaceId: LinearWorkspaceSelection | null
  teams: LinearTeam[]
  selectedTeamIds: ReadonlySet<string>
  teamSelectionIsStickyAll: boolean
  onWorkspaceChange: (workspaceId: LinearWorkspaceSelection) => void
  onTeamSelectionChange: (next: ReadonlySet<string>, persisted: string[] | null) => void
  onAddTeamAccess: () => void
  onOpen?: () => void
  className?: string
}

type LinearScopeLabelInput = Pick<
  LinearScopeSelectorProps,
  'workspaces' | 'selectedWorkspaceId' | 'teams' | 'selectedTeamIds' | 'teamSelectionIsStickyAll'
>

type LinearScopeTeamSelectionInput = {
  teams: LinearTeam[]
  currentSelectedTeamIds: ReadonlySet<string>
  nextSelectedTeamIds: ReadonlySet<string>
}

export function normalizeLinearScopeTeamSelection({
  teams,
  currentSelectedTeamIds,
  nextSelectedTeamIds
}: LinearScopeTeamSelectionInput): {
  selectedTeamIds: ReadonlySet<string>
  persisted: string[] | null
} {
  const visibleIds = teams.map((team) => team.id)
  if (visibleIds.length === 0) {
    return { selectedTeamIds: new Set(), persisted: null }
  }

  const visibleIdSet = new Set(visibleIds)
  const next = new Set([...nextSelectedTeamIds].filter((id) => visibleIdSet.has(id)))
  if (next.size === 0) {
    const current = [...currentSelectedTeamIds].filter((id) => visibleIdSet.has(id))
    const fallback = current.length > 0 ? current : visibleIds
    return {
      selectedTeamIds: new Set(fallback),
      persisted: fallback.length === visibleIds.length ? null : fallback
    }
  }

  if (next.size === visibleIds.length) {
    return { selectedTeamIds: new Set(visibleIds), persisted: null }
  }

  return { selectedTeamIds: next, persisted: [...next] }
}

function summarizeTeamKeys(
  teams: LinearTeam[],
  selectedTeamIds: ReadonlySet<string>,
  options: { activeAllWorkspaces: boolean; multipleWorkspaces: boolean }
): string {
  const selectedTeams = teams.filter((team) => selectedTeamIds.has(team.id))
  if (selectedTeams.length === 0) {
    return 'All teams'
  }

  if (options.activeAllWorkspaces && options.multipleWorkspaces) {
    const workspaceIds = new Set(selectedTeams.map((team) => team.workspaceId ?? ''))
    const keys = selectedTeams.map((team) => team.key)
    const keyCount = new Set(keys).size
    if (workspaceIds.size > 1 || keyCount < keys.length) {
      return `${selectedTeams.length} team${selectedTeams.length === 1 ? '' : 's'}`
    }
  }

  const [first, second, ...rest] = selectedTeams
  const labels = [first?.key, second?.key].filter(Boolean)
  return `${labels.join(', ')}${rest.length > 0 ? ` +${rest.length}` : ''}`
}

export function getLinearScopeTriggerLabel({
  workspaces,
  selectedWorkspaceId,
  teams,
  selectedTeamIds,
  teamSelectionIsStickyAll
}: LinearScopeLabelInput): string {
  const multipleWorkspaces = workspaces.length > 1
  const activeAllWorkspaces = selectedWorkspaceId === 'all'
  const selectedWorkspace =
    selectedWorkspaceId && selectedWorkspaceId !== 'all'
      ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
      : null
  const allVisibleTeamsSelected =
    teams.length > 0 && teams.every((team) => selectedTeamIds.has(team.id))
  const teamLabel =
    teamSelectionIsStickyAll || selectedTeamIds.size === 0 || allVisibleTeamsSelected
      ? 'All teams'
      : summarizeTeamKeys(teams, selectedTeamIds, {
          activeAllWorkspaces,
          multipleWorkspaces
        })

  if (!multipleWorkspaces) {
    return teamLabel
  }
  if (activeAllWorkspaces) {
    return teamLabel === 'All teams' ? 'All workspaces' : `All workspaces / ${teamLabel}`
  }
  return `${selectedWorkspace?.organizationName ?? 'Linear'} / ${teamLabel}`
}

export function LinearScopeSelector({
  workspaces,
  selectedWorkspaceId,
  teams,
  selectedTeamIds,
  teamSelectionIsStickyAll,
  onWorkspaceChange,
  onTeamSelectionChange,
  onAddTeamAccess,
  onOpen,
  className
}: LinearScopeSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces]
  )
  const triggerLabel = getLinearScopeTriggerLabel({
    workspaces,
    selectedWorkspaceId,
    teams,
    selectedTeamIds,
    teamSelectionIsStickyAll
  })
  const showWorkspaceNames = selectedWorkspaceId === 'all' || workspaces.length > 1
  const allTeamsSelected = teams.length > 0 && teams.every((team) => selectedTeamIds.has(team.id))
  const filteredTeams = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) {
      return teams
    }
    return teams.filter((team) => {
      const workspaceName =
        team.workspaceName ??
        (team.workspaceId ? workspaceById.get(team.workspaceId)?.organizationName : '')
      return [team.name, team.key, workspaceName ?? ''].some((value) =>
        value.toLowerCase().includes(trimmed)
      )
    })
  }, [query, teams, workspaceById])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        onOpen?.()
        return
      }
      setQuery('')
      setCommandValue('')
    },
    [onOpen]
  )

  const commitTeamSelection = useCallback(
    (nextSelectedTeamIds: ReadonlySet<string>) => {
      const normalized = normalizeLinearScopeTeamSelection({
        teams,
        currentSelectedTeamIds: selectedTeamIds,
        nextSelectedTeamIds
      })
      onTeamSelectionChange(normalized.selectedTeamIds, normalized.persisted)
    },
    [onTeamSelectionChange, selectedTeamIds, teams]
  )

  const handleAllTeams = useCallback(() => {
    onTeamSelectionChange(new Set(teams.map((team) => team.id)), null)
  }, [onTeamSelectionChange, teams])

  const handleTeamToggle = useCallback(
    (teamId: string) => {
      const next = new Set(selectedTeamIds)
      if (next.has(teamId)) {
        next.delete(teamId)
      } else {
        next.add(teamId)
      }
      commitTeamSelection(next)
    },
    [commitTeamSelection, selectedTeamIds]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'h-8 min-w-[180px] max-w-[260px] justify-between rounded-md border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none',
            className
          )}
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-1rem))] p-0">
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            autoFocus
            placeholder="Search teams..."
            value={query}
            onValueChange={setQuery}
            className="text-xs"
          />
          <CommandList className="max-h-[360px] scrollbar-sleek">
            {workspaces.length > 1 ? (
              <div className="border-b border-border py-1">
                <div className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase text-muted-foreground">
                  Workspace
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onWorkspaceChange('all')
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-accent hover:text-accent-foreground"
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      selectedWorkspaceId === 'all' ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <span>All workspaces</span>
                </button>
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    type="button"
                    onClick={() => {
                      onWorkspaceChange(workspace.id)
                      setOpen(false)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-accent hover:text-accent-foreground"
                  >
                    <Check
                      className={cn(
                        'size-3 text-muted-foreground',
                        selectedWorkspaceId === workspace.id ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <span className="min-w-0 truncate">{workspace.organizationName}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="border-b border-border py-1">
              <div className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase text-muted-foreground">
                Teams
              </div>
              <button
                type="button"
                onClick={handleAllTeams}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-accent hover:text-accent-foreground"
              >
                <Check
                  className={cn(
                    'size-3 text-muted-foreground',
                    allTeamsSelected || teamSelectionIsStickyAll ? 'opacity-70' : 'opacity-0'
                  )}
                />
                <span>All teams</span>
              </button>
            </div>
            {filteredTeams.length > 0 ? (
              filteredTeams.map((team) => {
                const isSelected = selectedTeamIds.has(team.id)
                const workspaceName =
                  team.workspaceName ??
                  (team.workspaceId ? workspaceById.get(team.workspaceId)?.organizationName : null)
                return (
                  <CommandItem
                    key={`${team.workspaceId ?? 'workspace'}:${team.id}`}
                    value={`${team.workspaceId ?? 'workspace'}:${team.id}`}
                    onSelect={() => handleTeamToggle(team.id)}
                    className="items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <Check
                      className={cn(
                        'size-3 text-muted-foreground',
                        isSelected ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate">{team.name}</span>
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                          {team.key}
                        </span>
                      </div>
                      {showWorkspaceNames && workspaceName ? (
                        <div className="truncate text-[11px] text-muted-foreground">
                          {workspaceName}
                        </div>
                      ) : null}
                    </div>
                  </CommandItem>
                )
              })
            ) : (
              <div className="px-3 py-5 text-xs leading-relaxed text-muted-foreground">
                {query.trim()
                  ? 'No fetched teams match your search.'
                  : 'No teams were fetched. Access can depend on key scope, private-team membership, archived teams, permissions, or a fetch failure.'}
              </div>
            )}
          </CommandList>
        </Command>
        <div className="border-t border-border p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onAddTeamAccess()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition hover:bg-accent hover:text-accent-foreground"
          >
            <KeyRound className="size-3.5 text-muted-foreground" />
            <span>Add team access</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
