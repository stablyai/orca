import React from 'react'
import { CalendarClock, Cloud, RefreshCw } from 'lucide-react'
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
import { useOrcaCloudApiAvailable } from '@/hooks/useOrcaCloudApiAvailability'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { repoLabel, type MemberDirectory } from './cloud-workspace-format'
import type { CloudWorkspaceRoutineRuns } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { OrcaCloudTrialUsedUpBanner } from '../new-workspace/run-on/OrcaCloudTrialUsedUpNotice'

export const ANY = '__any'

function openRoutines(): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({ pane: 'cloud-routines', repoId: null })
  state.openSettingsPage()
}

export type CloudWorkspacesFilters = {
  scope: 'team' | 'mine'
  by: string
  repo: string
  archived: boolean
  /** Only sandboxes that are running now (where the team's running slots go). */
  running?: boolean
  /** Also list workspaces routine runs started (hidden by default, like Conductor). */
  routines?: boolean
}

export const INITIAL_CLOUD_WORKSPACE_FILTERS: CloudWorkspacesFilters = {
  scope: 'team',
  by: ANY,
  repo: ANY,
  archived: false,
  running: false,
  routines: false
}

/** Row 1: title, count and cost, refresh. Row 2: whose, by whom, which repo, running, routine runs, archived. */
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
  onRefresh,
  routineRuns
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
  /** What the Routine runs switch hides; the switch exists only when the team has routines. */
  routineRuns?: CloudWorkspaceRoutineRuns
}): React.JSX.Element {
  const t = useTranslate()
  // Routines start cloud workspaces on their own, so they sit next to the list they fill.
  const routinesAvailable = useOrcaCloudApiAvailable()
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
        <span className="ml-auto flex items-center gap-1">
          {routinesAvailable ? (
            <Button size="xs" variant="ghost" onClick={openRoutines}>
              <CalendarClock />
              {t('auto.components.cloudWorkspaces.routines', 'Routines')}
            </Button>
          ) : null}
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
        {/* The switches wrap as one group, so none is left alone on a line of its own. */}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-7 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={filters.running === true}
              onCheckedChange={(running) => onFiltersChange({ running })}
              aria-label={t('auto.components.cloudWorkspaces.showRunningOnly', 'Show running only')}
            />
            {t('auto.components.cloudWorkspaces.running', 'Running')}
          </label>
          {(routineRuns?.routines ?? 0) > 0 || filters.routines === true ? (
            <label className="flex h-7 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={filters.routines === true}
                onCheckedChange={(routines) => onFiltersChange({ routines })}
                aria-label={t(
                  'auto.components.cloudWorkspaces.showRoutineRuns',
                  'Show routine runs'
                )}
              />
              {/* Hidden runs that are running still use hours: say how many, so the total adds up. */}
              {filters.routines !== true && (routineRuns?.hiddenRunning ?? 0) > 0 ? (
                <span className="tabular-nums">
                  {t(
                    'auto.components.cloudWorkspaces.routineRunsHidden',
                    'Routine runs · {{count}}',
                    {
                      count: routineRuns!.hiddenRunning
                    }
                  )}
                </span>
              ) : (
                t('auto.components.cloudWorkspaces.routineRuns', 'Routine runs')
              )}
            </label>
          ) : null}
          <label className="flex h-7 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={filters.archived}
              onCheckedChange={(archived) => onFiltersChange({ archived })}
              aria-label={t('auto.components.cloudWorkspaces.showArchived', 'Show archived')}
            />
            {t('auto.components.cloudWorkspaces.archived', 'Archived')}
          </label>
        </div>
      </div>
      {/* T4: the team's trial ran out; running sandboxes sleep until a plan starts. */}
      <OrcaCloudTrialUsedUpBanner />
    </div>
  )
}
