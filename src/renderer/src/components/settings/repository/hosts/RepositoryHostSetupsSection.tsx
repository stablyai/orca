import {
  setupsByOwnedExecutionHost,
  buildSetupHostOptions,
  getSetupStateLabel
} from './repository-host-setup-options'
import { getProjectHostSetupSelectionKey } from '@/lib/workspace/creation/project-host-setup-options'
import {
  getRepoExecutionHostId,
  getExecutionHostLabel,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../../../shared/execution-host/execution-host-registry'
import type { Project, ProjectHostSetup } from '../../../../../../shared/project-types'
import { useMemo, useState } from 'react'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/host-setting-overrides'
import type { Repo } from '../../../../../../shared/repo-types'
import { useAppStore } from '../../../../store/index'
import { getProjectHostSetupProjectionFromState } from '../../../../store/projects/project-host-setup-selector'
import { cn } from '../../../../lib/class-names'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsBadge } from '../../form-controls/SettingsFormControls'
import { matchesSettingsSearch, type SettingsSearchEntry } from '../../search/settings-search'

import { useTranslate } from '@/i18n/use-translate'
import { RepositoryHostSetupActions } from './RepositoryHostSetupActions'
import {
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel
} from '@/store/slices/ssh/runtime-environment-ssh-selectors'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { isConnectedRuntimeHostState } from '../../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'

type RepositoryHostSetupsSectionProps = {
  repo?: Repo
  project?: Project
  retainedSetups?: readonly ProjectHostSetup[]
  selectedProjectSetupId?: string
  selectedProjectHostId?: ExecutionHostId
  settingsSelectionKey?: string
  settingsEntryRepoIds?: ReadonlySet<string>
  forceVisible: boolean
  searchQuery: string
  searchEntries: SettingsSearchEntry[]
}

export function RepositoryHostSetupsSection({
  repo,
  project,
  retainedSetups,
  selectedProjectSetupId,
  selectedProjectHostId,
  settingsSelectionKey,
  settingsEntryRepoIds,
  forceVisible,
  searchQuery,
  searchEntries
}: RepositoryHostSetupsSectionProps): React.JSX.Element | null {
  const t = useTranslate()
  const setSettingsProjectHostSelection = useAppStore(
    (state) => state.setSettingsProjectHostSelection
  )
  const setupProjectExistingFolder = useAppStore((state) => state.setupProjectExistingFolder)
  const setupProjectClone = useAppStore((state) => state.setupProjectClone)
  const createProjectHostSetup = useAppStore((state) => state.createProjectHostSetup)
  const deleteProjectHostSetup = useAppStore((state) => state.deleteProjectHostSetup)
  const repos = useAppStore((state) => state.repos)
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const sshConnectionStates = useAppStore((state) => state.sshConnectionStates)
  const settings = useAppStore((state) => state.settings)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const sshStateByEnvironment = useAppStore((state) => state.sshStateByEnvironment)
  const removedSshTargetLabels = useAppStore((state) => state.removedSshTargetLabels)
  const sshTargetsHydrated = useAppStore((state) => state.sshTargetsHydrated)
  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const hostOptions = useMemo(
    () =>
      buildExecutionHostRegistry({
        repos,
        settings,
        hostSource: 'configured-only',
        sshTargetLabels,
        sshConnectionStates,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides
      }),
    [
      repos,
      settings,
      sshTargetLabels,
      sshConnectionStates,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides
    ]
  )
  const projectHostSetupProjection = useAppStore((state) =>
    getProjectHostSetupProjectionFromState(state)
  )
  const repoProjectHostSetup = projectHostSetupProjection.setups.find(
    (setup) => repo && setup.repoId === repo.id && setup.hostId === getRepoExecutionHostId(repo)
  )
  const allProjectHostSetups = projectHostSetupProjection.setups.filter(
    (setup) => setup.projectId === (project?.id ?? repoProjectHostSetup?.projectId)
  )
  const selectedProjectHostSetup =
    allProjectHostSetups.find(
      (setup) =>
        setup.id === selectedProjectSetupId &&
        setup.hostId ===
          (selectedProjectHostId ??
            (repo ? getRepoExecutionHostId(repo) : retainedSetups?.[0]?.hostId))
    ) ??
    repoProjectHostSetup ??
    retainedSetups?.find(
      (setup) => !selectedProjectHostId || setup.hostId === selectedProjectHostId
    )
  const selectedSetupKey = selectedProjectHostSetup
    ? getProjectHostSetupSelectionKey(selectedProjectHostSetup)
    : ''
  const displayName = project?.displayName ?? repo?.displayName ?? ''
  // Exclude sibling checkout setups, but retain project-level not-set-up placeholders for each entry.
  const projectHostSetups = setupsByOwnedExecutionHost(
    allProjectHostSetups.filter(
      (setup) =>
        !settingsEntryRepoIds || !setup.repoId.trim() || settingsEntryRepoIds.has(setup.repoId)
    ),
    selectedSetupKey
  )
  const openableProjectHostSetups = projectHostSetups.filter((setup) => setup.repoId.trim())
  const switchableProjectHostSetups = setupsByOwnedExecutionHost(
    openableProjectHostSetups,
    selectedSetupKey
  )
  const setupHostOptions = buildSetupHostOptions(
    {
      projectHostSetups: allProjectHostSetups,
      hostOptions
    },
    t
  )
  const hostOptionById = new Map(hostOptions.map((option) => [option.id, option]))
  const [deletingSetupId, setDeletingSetupId] = useState<string | null>(null)
  // Split clones share project IDs but need independent selections.
  const selectionKey = settingsSelectionKey ?? selectedProjectHostSetup?.projectId
  // Switch hosts within the project pane through ephemeral per-entry selection.
  const selectHost = (hostId: ExecutionHostId) => {
    if (selectionKey) {
      setSettingsProjectHostSelection(selectionKey, hostId)
    }
  }
  const selectSetup = (setup: ProjectHostSetup) => {
    if (selectionKey) {
      setSettingsProjectHostSelection(selectionKey, setup.hostId, setup.id)
    }
  }
  if (
    (projectHostSetups.length <= 1 && setupHostOptions.length === 0) ||
    (!forceVisible && !matchesSettingsSearch(searchQuery, searchEntries))
  ) {
    return null
  }

  return (
    <SearchableSetting
      title={t('auto.components.settings.RepositoryPane.82733ff808', 'Available hosts')}
      description={t(
        'auto.components.settings.RepositoryPane.availableHostsDescription',
        'Hosts where this project is set up.'
      )}
      keywords={[displayName, 'host', 'ssh', 'remote', 'vm', 'path']}
      className="space-y-3 py-3"
      forceVisible={forceVisible}
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Label className="text-sm font-semibold">
            {t('auto.components.settings.RepositoryPane.82733ff808', 'Available hosts')}
          </Label>
          {switchableProjectHostSetups.length > 1 ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('auto.components.settings.RepositoryPane.viewingHost', 'Viewing host')}
              </span>
              <Select
                value={selectedSetupKey}
                onValueChange={(setupKey) => {
                  if (setupKey === selectedSetupKey) {
                    return
                  }
                  const setup = switchableProjectHostSetups.find(
                    (candidate) => getProjectHostSetupSelectionKey(candidate) === setupKey
                  )
                  if (setup) {
                    selectSetup(setup)
                  }
                }}
              >
                <SelectTrigger className="h-8 w-44 min-w-0 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {switchableProjectHostSetups.map((setup) => (
                    <SelectItem
                      key={getProjectHostSetupSelectionKey(setup)}
                      value={getProjectHostSetupSelectionKey(setup)}
                    >
                      <span className="block min-w-0 truncate">
                        {hostOptionById.get(setup.executionHostId ?? setup.hostId)?.label ??
                          getExecutionHostLabel(setup.executionHostId ?? setup.hostId)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.RepositoryPane.availableHostsHelp',
            'Project paths and worktree settings are host-specific; creating a workspace can target any ready setup.'
          )}
        </p>
      </div>
      <div className="divide-y divide-border rounded-md border border-border">
        {projectHostSetups.map((setup) => {
          const executionHost = parseExecutionHostId(setup.executionHostId ?? setup.hostId)
          const transportHost = parseExecutionHostId(setup.hostId)
          const runtimeOwnerEnvironmentId =
            setup.runtimeOwnerEnvironmentId?.trim() ||
            (transportHost?.kind === 'runtime' ? transportHost.environmentId : null)
          // Share status-bar health derivation so degraded owners cannot appear Ready here.
          const runtimeOwnerStatusEntry = runtimeOwnerEnvironmentId
            ? runtimeStatusByEnvironmentId.get(runtimeOwnerEnvironmentId)
            : undefined
          const runtimeOwnerState = runtimeOwnerEnvironmentId
            ? runtimeHostConnectionStateForEntry(runtimeOwnerStatusEntry)
            : null
          const runtimeOwnerReachable =
            runtimeOwnerState === null || isConnectedRuntimeHostState(runtimeOwnerState)
          const runtimeOwnerWorkspaceWindowClosed = runtimeOwnerState === 'workspace-window-closed'
          const runtimeOwnerRuntimeUnavailable = runtimeOwnerState === 'runtime-unavailable'
          const runtimeOwnerHostId = runtimeOwnerEnvironmentId
            ? toRuntimeExecutionHostId(runtimeOwnerEnvironmentId)
            : null
          const runtimeOwnerHostLabel = runtimeOwnerHostId
            ? (hostOptionById.get(runtimeOwnerHostId)?.label ??
              getExecutionHostLabel(runtimeOwnerHostId))
            : ''
          const nestedSshStatus =
            runtimeOwnerEnvironmentId && executionHost?.kind === 'ssh'
              ? selectRuntimeAwareSshStatus(
                  { sshConnectionStates, sshStateByEnvironment, runtimeStatusByEnvironmentId },
                  runtimeOwnerEnvironmentId,
                  executionHost.targetId
                )
              : undefined
          const setupReady =
            setup.setupState === 'ready' &&
            runtimeOwnerReachable &&
            !runtimeOwnerWorkspaceWindowClosed &&
            !runtimeOwnerRuntimeUnavailable &&
            (nestedSshStatus === undefined || nestedSshStatus === 'connected')
          const setupStateLabel = !runtimeOwnerReachable
            ? t('auto.components.settings.RepositoryPane.hostStateDisconnected', 'Disconnected')
            : runtimeOwnerWorkspaceWindowClosed
              ? t(
                  'auto.components.settings.RepositoryPane.hostStateWorkspaceWindowClosed',
                  'Workspace window closed'
                )
              : runtimeOwnerRuntimeUnavailable
                ? t('auto.components.settings.RepositoryPane.hostStateUnknown', 'Unknown')
                : nestedSshStatus === null
                  ? t('auto.components.settings.RepositoryPane.hostStateUnknown', 'Unknown')
                  : nestedSshStatus !== undefined && nestedSshStatus !== 'connected'
                    ? t(
                        'auto.components.settings.RepositoryPane.hostStateDisconnected',
                        'Disconnected'
                      )
                    : getSetupStateLabel(setup.setupState, t)
          const setupHostLabel =
            runtimeOwnerEnvironmentId && executionHost?.kind === 'ssh'
              ? t(
                  'auto.components.settings.RepositoryPane.nestedHostLabel',
                  '{{value0}} via {{value1}}',
                  {
                    value0: selectRuntimeAwareSshTargetLabel(
                      {
                        sshConnectionStates,
                        sshTargetLabels,
                        removedSshTargetLabels,
                        sshTargetsHydrated,
                        sshStateByEnvironment,
                        runtimeStatusByEnvironmentId
                      },
                      runtimeOwnerEnvironmentId,
                      executionHost.targetId
                    ),
                    value1:
                      hostOptionById.get(setup.hostId)?.label ?? getExecutionHostLabel(setup.hostId)
                  }
                )
              : (hostOptionById.get(setup.hostId)?.label ?? getExecutionHostLabel(setup.hostId))
          const setupKey = getProjectHostSetupSelectionKey(setup)
          const isCurrentSetup = setupKey === selectedSetupKey
          const canOpenSetup = setup.repoId.trim().length > 0
          const canRemoveSetup = !canOpenSetup && deletingSetupId !== setupKey
          return (
            <div
              key={setupKey}
              data-current={isCurrentSetup ? 'true' : undefined}
              className={cn(
                'flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors',
                isCurrentSetup ? 'bg-accent' : ''
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{setupHostLabel}</span>
                  <SettingsBadge tone={setupReady ? 'accent' : 'muted'}>
                    {setupStateLabel}
                  </SettingsBadge>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {setup.path ||
                    t('auto.components.settings.RepositoryPane.setupPathPending', 'Path pending')}
                </p>
                {runtimeOwnerWorkspaceWindowClosed ? (
                  // RPC cannot open a remote desktop window; direct users to the owning host.
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t(
                      'auto.components.settings.RepositoryPane.hostWorkspaceWindowClosedHelp',
                      'The server is reachable but its Orca window is closed. Open Orca on {{value0}} to use this setup.',
                      { value0: runtimeOwnerHostLabel }
                    )}
                  </p>
                ) : null}
              </div>
              {isCurrentSetup ? (
                <SettingsBadge>
                  {t('auto.components.settings.RepositoryPane.currentSetup', 'Current')}
                </SettingsBadge>
              ) : null}
              {!isCurrentSetup && canOpenSetup ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    selectSetup(setup)
                  }}
                >
                  {t('auto.components.settings.RepositoryPane.openSetup', 'Open')}
                </Button>
              ) : null}
              {canRemoveSetup ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setDeletingSetupId(setupKey)
                    await deleteProjectHostSetup({ setupId: setup.id, hostId: setup.hostId })
                    setDeletingSetupId(null)
                  }}
                >
                  {t('auto.components.settings.RepositoryPane.removeSetup', 'Remove')}
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>
      {selectedProjectHostSetup ? (
        <RepositoryHostSetupActions
          repoDisplayName={displayName}
          selectedProjectHostSetup={selectedProjectHostSetup}
          setupHostOptions={setupHostOptions}
          setupProjectExistingFolder={setupProjectExistingFolder}
          setupProjectClone={setupProjectClone}
          createProjectHostSetup={createProjectHostSetup}
          onSetupReady={selectHost}
        />
      ) : null}
    </SearchableSetting>
  )
}
