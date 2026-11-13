// Settings › Workspaces controls: the By / In / search bar and each row's ⋯ menu, which offers
// only the actions teamWorkspaceActions allows.
import React from 'react'
import { Archive, ArrowUpRight, Moon, MoreHorizontal, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudWorkspace } from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import {
  memberName,
  repoLabel,
  type MemberDirectory
} from '../../cloud-workspaces/cloud-workspace-format'
import { cloudWorkspaceTitle } from '../../cloud-workspaces/open-cloud-workspace'
import { ANY, teamWorkspaceActions, type TeamWorkspaceFilters } from './team-workspaces-model'

export function RowActionsMenu({
  workspace: w,
  canAdmin,
  onOpen,
  onSleep,
  onArchive
}: {
  workspace: CloudWorkspace
  canAdmin: boolean
  onOpen: (w: CloudWorkspace) => void
  onSleep: (w: CloudWorkspace) => void
  onArchive: (w: CloudWorkspace) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const allowed = teamWorkspaceActions(w, canAdmin)
  if (!allowed.open && !allowed.sleep && !allowed.archive) {
    // Nothing this account may do to it: no empty menu.
    return <span aria-hidden className="size-6" />
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('auto.components.cloudWorkspaces.rowActions', 'Actions for {{value0}}', {
            value0: cloudWorkspaceTitle(w, t)
          })}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {allowed.open ? (
          <DropdownMenuItem onSelect={() => onOpen(w)}>
            <ArrowUpRight />
            {t('auto.components.cloudWorkspaces.open', 'Open')}
          </DropdownMenuItem>
        ) : null}
        {allowed.sleep ? (
          <DropdownMenuItem onSelect={() => onSleep(w)}>
            <Moon />
            {t('auto.components.cloudWorkspaces.sleep', 'Sleep')}
          </DropdownMenuItem>
        ) : null}
        {allowed.archive ? (
          <DropdownMenuItem onSelect={() => onArchive(w)}>
            <Archive />
            {t('auto.components.cloudWorkspaces.archive', 'Archive')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Filters({
  filters,
  onChange,
  people,
  repos,
  directory,
  selfId
}: {
  filters: TeamWorkspaceFilters
  onChange: (next: Partial<TeamWorkspaceFilters>) => void
  people: string[]
  repos: string[]
  directory: MemberDirectory
  selfId: string | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          density="compact"
          adornment="leading"
          value={filters.search}
          aria-label={t('settings.teamWorkspaces.search', 'Search workspaces')}
          placeholder={t(
            'settings.teamWorkspaces.searchPlaceholder',
            'Search by name, repository, person or W-number…'
          )}
          onChange={(event) => onChange({ search: event.target.value })}
        />
      </div>
      <Select value={filters.by} onValueChange={(by) => onChange({ by })}>
        <SelectTrigger
          size="sm"
          className="data-[size=sm]:h-7 w-[150px]"
          aria-label={t('settings.teamWorkspaces.filterBy', 'Filter by person')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{t('settings.teamWorkspaces.byAnyone', 'By anyone')}</SelectItem>
          {people.map((id) => (
            <SelectItem key={id} value={id}>
              {t('settings.teamWorkspaces.byPerson', 'By {{name}}', {
                name: memberName(directory, id, selfId, t)
              })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.repo} onValueChange={(repo) => onChange({ repo })}>
        <SelectTrigger
          size="sm"
          className="data-[size=sm]:h-7 w-[170px]"
          aria-label={t('settings.teamWorkspaces.filterIn', 'Filter by repository')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>
            {t('settings.teamWorkspaces.inAnyRepo', 'In any repository')}
          </SelectItem>
          {repos.map((url) => (
            <SelectItem key={url} value={url}>
              {t('settings.teamWorkspaces.inRepo', 'In {{repo}}', { repo: repoLabel(url) })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
