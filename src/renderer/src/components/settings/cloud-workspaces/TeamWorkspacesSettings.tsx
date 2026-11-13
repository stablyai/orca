// Settings › Workspaces: every cloud workspace on the team, for owners and admins to manage
// (Neil, HOME-1: the listing comes back only here). Open, Sleep and Archive use the same flows as
// the sidebar and "Open cloud workspace…"; an action the control plane would refuse is not shown.
import React, { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Lock, RefreshCw, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CloudStatusGlyph } from '@/components/orca-cloud/CloudStatusGlyph'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { useAppStore } from '@/store'
import {
  formatWorkspaceNumber,
  type CloudWorkspace
} from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { MemberAvatar } from '../../cloud-workspaces/CloudMemberAvatars'
import { dotState, statusLabel } from '../../cloud-workspaces/CloudWorkspaceRow'
import { ErrorState, SkeletonRows } from '../../cloud-workspaces/CloudWorkspacesStates'
import {
  CloudWorkspaceConfirmDialog,
  type PendingConfirm
} from '../../cloud-workspaces/CloudWorkspaceConfirmDialog'
import * as archive from '../../cloud-workspaces/cloud-workspace-home-archive'
import {
  formatRelative,
  memberName,
  repoLabel
} from '../../cloud-workspaces/cloud-workspace-format'
import { useListedCloudWorkspaces } from '../../cloud-workspaces/cloud-workspace-local-titles'
import {
  cloudWorkspaceTitle,
  openCloudWorkspace
} from '../../cloud-workspaces/open-cloud-workspace'
import { useMemberDirectory } from '../../cloud-workspaces/use-cloud-workspace-row-actions'
import { useCloudWorkspaces } from '../../cloud-workspaces/use-cloud-workspaces'
import {
  ANY,
  INITIAL_TEAM_WORKSPACE_FILTERS,
  createdByOf,
  teamWorkspaceFilterOptions,
  teamWorkspaceRows,
  type TeamWorkspaceFilters
} from './team-workspaces-model'
import { Filters, RowActionsMenu } from './TeamWorkspacesControls'

const TEAM_QUERY = { scope: 'team', archived: 'include' } as const

export function TeamWorkspacesSettings({ orgId }: { orgId: string | null }): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const signIn = useAppStore((s) => s.connectCurrentOrcaProfile)
  const account = useOrcaAccountKey()
  const selfId = cloud?.userId ?? null
  const [filters, setFilters] = useState(INITIAL_TEAM_WORKSPACE_FILTERS)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const { state, stale, reading, refresh } = useCloudWorkspaces(TEAM_QUERY, Boolean(cloud), account)
  useEffect(
    () => installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 30_000 }),
    []
  )
  const all = useListedCloudWorkspaces(state.status === 'ready' ? state.workspaces : null)
  const { directory, canAdmin } = useMemberDirectory(orgId ?? undefined, all)
  const { people, repos } = useMemo(() => teamWorkspaceFilterOptions(all), [all])
  // A person or repository that left the list stops filtering.
  const effective = useMemo<TeamWorkspaceFilters>(
    () => ({
      ...filters,
      by: people.includes(filters.by) ? filters.by : ANY,
      repo: repos.includes(filters.repo) ? filters.repo : ANY
    }),
    [filters, people, repos]
  )
  const rows = useMemo(
    () => teamWorkspaceRows(all, effective, directory),
    [all, effective, directory]
  )
  const archiveActions = useMemo(
    () => archive.homeArchiveActions({ selfId, t, refresh, confirmArchive: setConfirm }),
    [refresh, selfId, t]
  )
  const open = (w: CloudWorkspace): void => {
    void openCloudWorkspace(w).then((outcome) => {
      if (!outcome.ok) {
        toast.error(outcome.message)
      }
    })
  }

  return (
    <div className="space-y-3" data-team-workspaces="">
      <div className="flex items-center gap-2">
        <Filters
          filters={effective}
          onChange={(next) => setFilters((previous) => ({ ...previous, ...next }))}
          people={people}
          repos={repos}
          directory={directory}
          selfId={selfId}
        />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={refresh}
          aria-busy={reading}
          aria-label={t('auto.components.cloudWorkspaces.refresh', 'Refresh cloud workspaces')}
        >
          <RefreshCw className={cn(reading && 'motion-safe:animate-spin')} />
        </Button>
      </div>
      <div
        aria-busy={stale || state.status === 'loading'}
        className={cn(
          'overflow-hidden rounded-md border border-border/60 transition-opacity motion-reduce:transition-none',
          stale && 'opacity-60'
        )}
      >
        {state.status === 'error' ? (
          <ErrorState
            error={state.error}
            reason={state.reason}
            retrying={reading}
            onRetry={refresh}
            onSignIn={() => {
              void signIn().then(refresh)
            }}
          />
        ) : state.status !== 'ready' ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            {all.length === 0
              ? t(
                  'settings.teamWorkspaces.emptyTeam',
                  'No one on your team has a cloud workspace yet.'
                )
              : t('settings.teamWorkspaces.emptyFiltered', 'No workspaces match these filters.')}
          </p>
        ) : (
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col />
              <col className="w-16" />
              <col className="w-36" />
              <col className="w-32" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-10" />
            </colgroup>
            <thead className="border-b border-border/60 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">
                  {t('settings.teamWorkspaces.colName', 'Workspace')}
                </th>
                <th className="px-2 py-2 font-medium">
                  {t('settings.teamWorkspaces.colNumber', 'No.')}
                </th>
                <th className="px-2 py-2 font-medium">
                  {t('settings.teamWorkspaces.colCreatedBy', 'Created by')}
                </th>
                <th className="px-2 py-2 font-medium">
                  {t('settings.teamWorkspaces.colState', 'State')}
                </th>
                <th className="px-2 py-2 font-medium">
                  {t('settings.teamWorkspaces.colLastActive', 'Last active')}
                </th>
                <th className="px-2 py-2 font-medium">
                  {t('settings.teamWorkspaces.colAccess', 'Access')}
                </th>
                <th className="px-2 py-2">
                  <span className="sr-only">
                    {t('settings.teamWorkspaces.colActions', 'Actions')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((w) => {
                const creator = createdByOf(w)
                const status = statusLabel(w, t)
                return (
                  <tr key={w.id} data-team-workspace-row={w.id} className="align-middle">
                    <td className="px-3 py-2">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {cloudWorkspaceTitle(w, t)}
                      </span>
                      {w.repo ? (
                        <span className="block truncate text-muted-foreground">
                          {repoLabel(w.repo.url)}
                          {w.repo.branch ? ` · ${w.repo.branch}` : ''}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 font-mono text-muted-foreground tabular-nums">
                      {w.number ? formatWorkspaceNumber(w.number) : '—'}
                    </td>
                    <td className="px-2 py-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <MemberAvatar
                          userId={creator}
                          directory={directory}
                          selfId={selfId}
                          size="sm"
                        />
                        <span className="truncate">
                          {memberName(directory, creator, selfId, t)}
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span className="flex items-center gap-1.5">
                        <CloudStatusGlyph state={dotState(w)} size={14} />
                        <span className="truncate">{status}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-muted-foreground tabular-nums">
                      {formatRelative(w.lastActivityAt, now, t, intlLocale)}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">
                      <span className="flex items-center gap-1">
                        {w.visibility === 'private' ? (
                          <Lock className="size-3 shrink-0" aria-hidden />
                        ) : (
                          <Users className="size-3 shrink-0" aria-hidden />
                        )}
                        {w.visibility === 'private'
                          ? t('auto.components.cloudWorkspaces.private', 'Private')
                          : t('settings.teamWorkspaces.shared', 'Shared')}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <RowActionsMenu
                        workspace={w}
                        canAdmin={canAdmin}
                        onOpen={open}
                        onSleep={archiveActions.sleep}
                        onArchive={archiveActions.archive}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {state.status === 'ready' && all.length > 0 ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('settings.teamWorkspaces.shownOf', '{{shown}} of {{count}} workspaces', {
            shown: rows.length,
            count: all.length,
            defaultValue_one: '{{shown}} of {{count}} workspace'
          })}
        </p>
      ) : null}
      {confirm && (
        <CloudWorkspaceConfirmDialog
          pending={confirm}
          directory={directory}
          selfId={selfId}
          canAdmin={canAdmin}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm.kind === 'archive' || confirm.kind === 'delete') {
              archive.runConfirmed(confirm, t, refresh)
            }
            setConfirm(null)
          }}
        />
      )}
    </div>
  )
}
