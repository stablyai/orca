// "Open cloud workspace…": cloud workspaces this computer's sidebar doesn't show, as the same rows
// (and ⋯ menu) the team list had. Open goes through openCloudWorkspace and closes the picker.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsSegmentedControl } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { openNewCloudWorkspace } from '@/hooks/ipc-events/new-workspace-command'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { useAppStore } from '@/store'
import { OrcaCloudTrialUsedUpBanner } from '../new-workspace/run-on/OrcaCloudTrialUsedUpNotice'
import { CloudWorkspaceRow } from './CloudWorkspaceRow'
import {
  ErrorState,
  PickerEmptyState,
  SkeletonRows,
  type PickerEmptyReason
} from './CloudWorkspacesStates'
import { useListedCloudWorkspaces } from './cloud-workspace-local-titles'
import { useCloudWorkspaceIdsInSidebar } from './cloud-workspaces-in-sidebar'
import {
  initialPickerControls,
  pickerHidesSidebarWorkspaces,
  pickerListQuery,
  pickerRows,
  pickerShowsArchived,
  pickerShowsScope,
  type CloudWorkspacePickerControls
} from './cloud-workspace-picker-model'
import {
  closeCloudWorkspacePicker,
  useCloudWorkspacePickerRequest,
  type CloudWorkspacePickerFocus
} from './cloud-workspace-picker-store'
import { useCloudWorkspaceRowActions, useMemberDirectory } from './use-cloud-workspace-row-actions'
import { useCloudWorkspaces } from './use-cloud-workspaces'

function pickerCopy(
  focus: CloudWorkspacePickerFocus,
  teammateName: string | null,
  t: Translate
): { title: string; description: string } {
  switch (focus.kind) {
    case 'open':
      return {
        title: t('components.cloudWorkspaces.picker.title', 'Open cloud workspace'),
        description: t(
          'components.cloudWorkspaces.picker.description',
          'Cloud workspaces that aren’t in your sidebar: shared by teammates, or started on another computer.'
        )
      }
    case 'teammate':
      return {
        title: teammateName
          ? t('components.cloudWorkspaces.picker.teammateTitle', '{{name}}’s cloud workspaces', {
              name: teammateName
            })
          : t('components.cloudWorkspaces.picker.title', 'Open cloud workspace'),
        description: t(
          'components.cloudWorkspaces.picker.teammateDescription',
          'The ones they own or started that you can see.'
        )
      }
    case 'running':
      return {
        title: t('components.cloudWorkspaces.picker.runningTitle', 'Your running cloud workspaces'),
        description: t(
          'components.cloudWorkspaces.picker.runningDescription',
          'Put one to sleep or delete it to free a running slot, then try again.'
        )
      }
    case 'team-cleanup':
      return {
        title: t('components.cloudWorkspaces.picker.teamTitle', 'Your team’s cloud workspaces'),
        description: t(
          'components.cloudWorkspaces.picker.teamDescription',
          'Delete these, archived ones too, before deleting the team.'
        )
      }
  }
}

function emptyReason({
  focus,
  controls,
  hiddenInSidebar,
  listedBeforeSearch,
  teammateName
}: {
  focus: CloudWorkspacePickerFocus
  controls: CloudWorkspacePickerControls
  hiddenInSidebar: number
  listedBeforeSearch: boolean
  teammateName: string | null
}): PickerEmptyReason {
  if (controls.search.trim() && listedBeforeSearch) {
    return { kind: 'search' }
  }
  if (controls.archived && pickerShowsArchived(focus)) {
    return { kind: 'archived' }
  }
  if (focus.kind === 'running') {
    return { kind: 'none-running' }
  }
  if (focus.kind === 'teammate') {
    return { kind: 'teammate', name: teammateName ?? '' }
  }
  return hiddenInSidebar > 0 ? { kind: 'all-in-sidebar' } : { kind: 'none' }
}

/** The picker's body; the dialog shell is CloudWorkspacePickerDialog. */
export function CloudWorkspacePicker({
  focus,
  onClose
}: {
  focus: CloudWorkspacePickerFocus
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const signIn = useAppStore((s) => s.connectCurrentOrcaProfile)
  const account = useOrcaAccountKey()
  const orgId = cloud?.activeOrgId
  const hasOrg = Boolean(orgId)
  const selfId = cloud?.userId ?? null
  const [controls, setControls] = useState(() => initialPickerControls(hasOrg))
  const [now, setNow] = useState(() => Date.now())
  const change = (next: Partial<CloudWorkspacePickerControls>): void =>
    setControls((previous) => ({ ...previous, ...next }))
  const query = pickerListQuery(focus, controls, hasOrg)
  const { state, stale, reading, refresh, replace } = useCloudWorkspaces(
    query,
    Boolean(cloud),
    account
  )
  const inSidebar = useCloudWorkspaceIdsInSidebar(pickerHidesSidebarWorkspaces(focus))

  // Relative "last active" times tick while the window is visible.
  useEffect(
    () => installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 30_000 }),
    []
  )

  const all = useListedCloudWorkspaces(state.status === 'ready' ? state.workspaces : null)
  const { directory, canAdmin } = useMemberDirectory(orgId, all)
  const { rows, hiddenInSidebar } = useMemo(
    () =>
      pickerRows({
        workspaces: all,
        focus,
        inSidebar: inSidebar ?? new Set(),
        search: controls.search,
        directory
      }),
    [all, focus, inSidebar, controls.search, directory]
  )
  const listedBeforeSearch = useMemo(
    () =>
      pickerRows({
        workspaces: all,
        focus,
        inSidebar: inSidebar ?? new Set(),
        search: '',
        directory
      }).rows.length > 0,
    [all, focus, inSidebar, directory]
  )
  const teammateName =
    focus.kind === 'teammate' ? (directory.get(focus.userId)?.name ?? null) : null
  const members = useMemo(
    () =>
      [...directory.entries()].map(([userId, m]) => ({
        userId,
        name:
          userId === selfId
            ? t('auto.components.cloudWorkspaces.memberYou', '{{value0}} (you)', { value0: m.name })
            : m.name
      })),
    [directory, selfId, t]
  )
  const { actions, openingId, dialogs } = useCloudWorkspaceRowActions({
    workspaces: all,
    directory,
    selfId,
    canAdmin,
    refresh,
    replace,
    onOpened: onClose
  })

  const copy = pickerCopy(focus, teammateName, t)
  const loading = state.status === 'loading' || (state.status === 'ready' && inSidebar === null)

  return (
    <div className="flex min-h-0 flex-col gap-3" data-cloud-workspace-picker={focus.kind}>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            autoFocus
            density="compact"
            adornment="leading"
            value={controls.search}
            aria-label={t('components.cloudWorkspaces.picker.search', 'Search cloud workspaces')}
            placeholder={t(
              'components.cloudWorkspaces.picker.searchPlaceholder',
              'Search by title, repository, owner or W-number…'
            )}
            onChange={(event) => change({ search: event.target.value })}
          />
        </div>
        {pickerShowsScope(focus, hasOrg) ? (
          <SettingsSegmentedControl
            size="sm"
            ariaLabel={t('auto.components.cloudWorkspaces.whoseWorkspaces', 'Whose workspaces')}
            value={controls.scope}
            onChange={(scope) => change({ scope })}
            options={[
              { value: 'team', label: t('auto.components.cloudWorkspaces.scopeTeam', 'Team') },
              { value: 'mine', label: t('auto.components.cloudWorkspaces.scopeMine', 'Mine') }
            ]}
          />
        ) : null}
        {pickerShowsArchived(focus) ? (
          <label className="flex h-7 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={controls.archived}
              onCheckedChange={(archived) => change({ archived })}
              aria-label={t('auto.components.cloudWorkspaces.showArchived', 'Show archived')}
            />
            {t('auto.components.cloudWorkspaces.archived', 'Archived')}
          </label>
        ) : null}
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
      {/* T4: the team's trial ran out; running sandboxes sleep until a plan starts. */}
      <OrcaCloudTrialUsedUpBanner />
      <div
        aria-busy={stale || loading}
        className={cn(
          'scrollbar-sleek min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-1 transition-opacity motion-reduce:transition-none',
          stale && 'opacity-60'
        )}
      >
        {!cloud ? (
          // Signed out since it opened (or opened signed out): the list needs the account.
          <ErrorState
            error="unauthorized"
            retrying={false}
            onRetry={refresh}
            onSignIn={() => {
              void signIn().then(refresh)
            }}
          />
        ) : state.status === 'error' ? (
          <ErrorState
            error={state.error}
            reason={state.reason}
            retrying={reading}
            onRetry={refresh}
            onSignIn={() => {
              void signIn().then(refresh)
            }}
          />
        ) : loading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <PickerEmptyState
            reason={emptyReason({
              focus,
              controls,
              hiddenInSidebar,
              listedBeforeSearch,
              teammateName
            })}
            onCreate={() => {
              onClose()
              openNewCloudWorkspace(useAppStore.getState(), 'unknown')
            }}
          />
        ) : (
          <ul aria-label={copy.title}>
            {rows.map((w) => (
              <CloudWorkspaceRow
                key={w.id}
                workspace={w}
                directory={directory}
                selfId={selfId}
                canAdmin={canAdmin}
                members={members}
                opening={openingId === w.id}
                now={now}
                actions={actions}
              />
            ))}
          </ul>
        )}
      </div>
      {hiddenInSidebar > 0 && rows.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.cloudWorkspaces.picker.inSidebarNote',
            '{{count}} more are already in your sidebar.',
            {
              count: hiddenInSidebar,
              defaultValue_one: '{{count}} more is already in your sidebar.'
            }
          )}
        </p>
      ) : null}
      {dialogs}
    </div>
  )
}

/** Mounted once in App; any surface opens it with openCloudWorkspacePicker(). */
export function CloudWorkspacePickerDialog(): React.JSX.Element {
  const request = useCloudWorkspacePickerRequest()
  const close = useCallback(() => closeCloudWorkspacePicker(), [])
  const open = request !== null
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      {open ? (
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
          {/* Remount per request so a new focus starts with its own controls. */}
          <CloudWorkspacePicker key={request.id} focus={request.focus} onClose={close} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
