import React from 'react'
import { Cloud, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingsSegmentedControl } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { repoLabel, type MemberDirectory } from './cloud-workspace-format'

export const ANY = '__any'

export type CloudWorkspacesFilters = {
  scope: 'team' | 'mine'
  by: string
  repo: string
  archived: boolean
}

/** Row 1: title, count and cost, refresh. Row 2: whose, by whom, which repo, archived. */
export function CloudWorkspacesToolbar({
  filters,
  onFiltersChange,
  hasOrg,
  owners,
  repos,
  directory,
  selfId,
  meta,
  metaStale,
  reading,
  onRefresh
}: {
  filters: CloudWorkspacesFilters
  onFiltersChange: (next: Partial<CloudWorkspacesFilters>) => void
  hasOrg: boolean
  owners: string[]
  repos: string[]
  directory: MemberDirectory
  selfId: string | null
  meta: string | null
  /** The meta line belongs to the previous filter until the new read lands. */
  metaStale: boolean
  reading: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mb-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Cloud className="size-4 text-muted-foreground" aria-hidden />
        <h2 id="cloud-workspaces-heading" className="text-sm font-semibold text-foreground">
          {t('auto.components.cloudWorkspaces.heading', 'Cloud workspaces')}
        </h2>
        {meta && (
          <span
            className={cn(
              'text-xs tabular-nums text-muted-foreground transition-opacity motion-reduce:transition-none',
              metaStale && 'opacity-60'
            )}
          >
            {meta}
          </span>
        )}
        <span className="ml-auto">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onRefresh}
            aria-busy={reading}
            aria-label={t('auto.components.cloudWorkspaces.refresh', 'Refresh cloud workspaces')}
          >
            <RefreshCw className={cn(reading && 'motion-safe:animate-spin')} />
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {hasOrg && (
          <div className="flex h-7 shrink-0 items-center">
            <SettingsSegmentedControl
              size="sm"
              ariaLabel={t('auto.components.cloudWorkspaces.whoseWorkspaces', 'Whose workspaces')}
              value={filters.scope}
              onChange={(scope) => onFiltersChange({ scope })}
              options={[
                { value: 'team', label: t('auto.components.cloudWorkspaces.scopeTeam', 'Team') },
                { value: 'mine', label: t('auto.components.cloudWorkspaces.scopeMine', 'Mine') }
              ]}
            />
          </div>
        )}
        {hasOrg && filters.scope === 'team' && (
          <Select value={filters.by} onValueChange={(by) => onFiltersChange({ by })}>
            <SelectTrigger
              size="sm"
              className="data-[size=sm]:h-7 w-[132px]"
              aria-label={t('auto.components.cloudWorkspaces.filterByOwner', 'Filter by owner')}
            >
              <SelectValue
                placeholder={t('auto.components.cloudWorkspaces.byAnyone', 'By anyone')}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>
                {t('auto.components.cloudWorkspaces.byAnyone', 'By anyone')}
              </SelectItem>
              {owners.map((id) => (
                <SelectItem key={id} value={id}>
                  {id === selfId
                    ? t('auto.components.cloudWorkspaces.byMe', 'By me')
                    : t('auto.components.cloudWorkspaces.byMember', 'By {{value0}}', {
                        value0: directory.get(id)?.name ?? id
                      })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={filters.repo} onValueChange={(repo) => onFiltersChange({ repo })}>
          <SelectTrigger
            size="sm"
            className="data-[size=sm]:h-7 w-[150px]"
            aria-label={t(
              'auto.components.cloudWorkspaces.filterByRepository',
              'Filter by repository'
            )}
          >
            <SelectValue
              placeholder={t('auto.components.cloudWorkspaces.inAnyRepo', 'In any repo')}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>
              {t('auto.components.cloudWorkspaces.inAnyRepo', 'In any repo')}
            </SelectItem>
            {repos.map((url) => (
              <SelectItem key={url} value={url}>
                {t('auto.components.cloudWorkspaces.inRepo', 'In {{value0}}', {
                  value0: repoLabel(url)
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="ml-auto flex h-7 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={filters.archived}
            onCheckedChange={(archived) => onFiltersChange({ archived })}
            aria-label={t('auto.components.cloudWorkspaces.showArchived', 'Show archived')}
          />
          {t('auto.components.cloudWorkspaces.archived', 'Archived')}
        </label>
      </div>
    </div>
  )
}
