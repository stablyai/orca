import React from 'react'
import { ChevronDown, LayoutGrid, List, RefreshCw, SlidersHorizontal, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsTeam
} from '../../../../../shared/azure-devops/boards-types'

export type AzureDevOpsToolbarProps = {
  teams: AzureDevOpsTeam[]
  selectedTeamName: string | null
  onSelectTeam: (teamName: string) => void
  levels: AzureDevOpsBacklogLevel[]
  selectedLevelId: string | null
  onSelectLevel: (levelId: string) => void
  view: 'backlog' | 'board'
  onSelectView: (view: 'backlog' | 'board') => void
  boardAvailable: boolean
  showParents: boolean
  onToggleShowParents: (next: boolean) => void
  /** ADO's "In progress items" view option: false hides InProgress-category items. */
  showInProgress: boolean
  onToggleShowInProgress: (next: boolean) => void
  /** Present only while local column-width overrides exist. */
  onResetColumnWidths: (() => void) | null
  onRefresh: () => void
  refreshing: boolean
}

function ShowParentsToggle(props: AzureDevOpsToolbarProps): React.JSX.Element {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Checkbox
        aria-label={translate('auto.components.TaskPage.azureDevOps.showParents', 'Show parents')}
        checked={props.showParents}
        onCheckedChange={(checked) => props.onToggleShowParents(checked === true)}
      />
      {translate('auto.components.TaskPage.azureDevOps.showParents', 'Show parents')}
    </label>
  )
}

/** Backlog-only view options: neither the in-progress filter nor column widths touch the board. */
function BacklogViewOptions(props: AzureDevOpsToolbarProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={translate('auto.components.TaskPage.azureDevOps.viewOptions', 'View options')}
        >
          <SlidersHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={props.showInProgress}
          onCheckedChange={(checked) => props.onToggleShowInProgress(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate('auto.components.TaskPage.azureDevOps.inProgressItems', 'In progress items')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={props.onResetColumnWidths === null}
          onSelect={() => props.onResetColumnWidths?.()}
        >
          {translate(
            'auto.components.TaskPage.azureDevOps.resetColumnWidths',
            'Reset column widths'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AzureDevOpsToolbar(props: AzureDevOpsToolbarProps): React.JSX.Element {
  const selectedLevel = props.levels.find((l) => l.id === props.selectedLevelId) ?? null
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Users className="size-3.5" />
            {props.selectedTeamName ??
              translate('auto.components.TaskPage.azureDevOps.pickTeam', 'Pick a team')}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {props.teams.map((team) => (
            <DropdownMenuItem key={team.id} onSelect={() => props.onSelectTeam(team.name)}>
              {team.name}
              {team.isDefault ? (
                <span className="ml-2 text-[11px] text-muted-foreground">
                  {translate('auto.components.TaskPage.azureDevOps.defaultTeam', 'default')}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {selectedLevel?.name ??
              translate('auto.components.TaskPage.azureDevOps.pickLevel', 'Pick a level')}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {props.levels.map((level) => (
            <DropdownMenuItem key={level.id} onSelect={() => props.onSelectLevel(level.id)}>
              {level.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex items-center gap-2">
        {props.view === 'backlog' ? <ShowParentsToggle {...props} /> : null}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={props.view}
          onValueChange={(value) => {
            if (value === 'backlog' || value === 'board') {
              props.onSelectView(value)
            }
          }}
        >
          <ToggleGroupItem value="backlog">
            <List className="size-3.5" />
            {translate('auto.components.TaskPage.azureDevOps.backlogView', 'Backlog')}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="board"
            disabled={!props.boardAvailable || props.selectedLevelId === null}
          >
            <LayoutGrid className="size-3.5" />
            {translate('auto.components.TaskPage.azureDevOps.boardView', 'Board')}
          </ToggleGroupItem>
        </ToggleGroup>
        {props.view === 'backlog' ? <BacklogViewOptions {...props} /> : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onRefresh}
          disabled={props.refreshing}
          aria-label={translate('auto.components.TaskPage.azureDevOps.refresh', 'Refresh')}
        >
          <RefreshCw className={cn('size-3.5', props.refreshing && 'animate-spin')} />
        </Button>
      </div>
    </div>
  )
}
