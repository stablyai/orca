import { useMemo, useState } from 'react'
import {
  getExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import type { ProjectHostSetup, Repo } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { getProjectHostSetupProjectionFromState } from '../../store/selectors'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsBadge } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { buildSetupHostOptions, getSetupStateLabel } from './repository-host-setup-options'
import { RepositoryHostSetupActions } from './RepositoryHostSetupActions'
import {
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel
} from '@/store/slices/runtime-environment-ssh'

type RepositoryHostSetupsSectionProps = {
  repo: Repo
  selectedProjectSetupId?: string
  forceVisible: boolean
  searchQuery: string
  searchEntries: SettingsSearchEntry[]
}

function setupsByOwnedExecutionHost(
  setups: readonly ProjectHostSetup[],
  selectedSetupId: string
): ProjectHostSetup[] {
  const byHost = new Map<string, ProjectHostSetup>()
  for (const setup of setups) {
    const key = JSON.stringify([
      setup.hostId,
      setup.executionHostId ?? setup.hostId,
      setup.runtimeOwnerEnvironmentId ?? null
    ])
    if (!byHost.has(key) || setup.id === selectedSetupId) {
      byHost.set(key, setup)
    }
  }
  return [...byHost.values()]
}

export function RepositoryHostSetupsSection({
  repo,
  selectedProjectSetupId,
  forceVisible,
  searchQuery,
  searchEntries
}: RepositoryHostSetupsSectionProps): React.JSX.Element | null {
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
    (setup) => setup.repoId === repo.id
  )
  const selectedProjectHostSetup =
    projectHostSetupProjection.setups.find(
      (setup) =>
        setup.id === selectedProjectSetupId &&
        setup.repoId === repo.id &&
        setup.projectId === repoProjectHostSetup?.projectId
    ) ?? repoProjectHostSetup
  const projectHostSetups = selectedProjectHostSetup
    ? setupsByOwnedExecutionHost(
        projectHostSetupProjection.setups.filter(
          (setup) => setup.projectId === selectedProjectHostSetup.projectId
        ),
        selectedProjectHostSetup.id
      )
    : []
  const openableProjectHostSetups = projectHostSetups.filter((setup) => setup.repoId.trim())
  const switchableProjectHostSetups = setupsByOwnedExecutionHost(
    openableProjectHostSetups,
    selectedProjectHostSetup?.id ?? ''
  )
  const setupHostOptions = buildSetupHostOptions({
    projectHostSetups,
    hostOptions
  })
  const hostOptionById = new Map(hostOptions.map((option) => [option.id, option]))
  const [deletingSetupId, setDeletingSetupId] = useState<string | null>(null)
  const projectId = selectedProjectHostSetup?.projectId
  // Why: the single project pane switches host in place — set the ephemeral
  // per-project selection instead of navigating to a separate repo section.
  const selectHost = (hostId: ExecutionHostId) => {
    if (projectId) {
      setSettingsProjectHostSelection(projectId, hostId)
    }
  }
  const selectSetup = (setup: ProjectHostSetup) => {
    if (projectId) {
      setSettingsProjectHostSelection(projectId, setup.hostId, setup.id)
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
      title={translate('auto.components.settings.RepositoryPane.availableHosts', 'Available Hosts')}
      description={translate(
        'auto.components.settings.RepositoryPane.availableHostsDescription',
        'Hosts where this project is set up.'
      )}
      keywords={[repo.displayName, 'host', 'ssh', 'remote', 'vm', 'path']}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Label className="text-sm font-semibold">
            {translate('auto.components.settings.RepositoryPane.availableHosts', 'Available Hosts')}
          </Label>
          {switchableProjectHostSetups.length > 1 ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {translate('auto.components.settings.RepositoryPane.viewingHost', 'Viewing host')}
              </span>
              <Select
                value={selectedProjectHostSetup?.id}
                onValueChange={(setupId) => {
                  if (setupId === selectedProjectHostSetup?.id) {
                    return
                  }
                  const setup = switchableProjectHostSetups.find(
                    (candidate) => candidate.id === setupId
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
                    <SelectItem key={setup.id} value={setup.id}>
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
          {translate(
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
          const runtimeOwnerReachable =
            !runtimeOwnerEnvironmentId ||
            Boolean(runtimeStatusByEnvironmentId.get(runtimeOwnerEnvironmentId)?.status)
          const nestedSshStatus =
            runtimeOwnerEnvironmentId && executionHost?.kind === 'ssh'
              ? selectRuntimeAwareSshStatus(
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
                )
              : undefined
          const setupReady =
            setup.setupState === 'ready' &&
            runtimeOwnerReachable &&
            (nestedSshStatus === undefined || nestedSshStatus === 'connected')
          const setupStateLabel = !runtimeOwnerReachable
            ? translate(
                'auto.components.settings.RepositoryPane.hostStateDisconnected',
                'Disconnected'
              )
            : nestedSshStatus === null
              ? translate('auto.components.settings.RepositoryPane.hostStateUnknown', 'Unknown')
              : nestedSshStatus !== undefined && nestedSshStatus !== 'connected'
                ? translate(
                    'auto.components.settings.RepositoryPane.hostStateDisconnected',
                    'Disconnected'
                  )
                : getSetupStateLabel(setup.setupState)
          const setupHostLabel =
            runtimeOwnerEnvironmentId && executionHost?.kind === 'ssh'
              ? translate(
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
          const isCurrentSetup = setup.id === selectedProjectHostSetup?.id
          const canOpenSetup = setup.repoId.trim().length > 0
          const canRemoveSetup = !canOpenSetup && deletingSetupId !== setup.id
          return (
            <div
              key={setup.id}
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
                    translate(
                      'auto.components.settings.RepositoryPane.setupPathPending',
                      'Path pending'
                    )}
                </p>
              </div>
              {isCurrentSetup ? (
                <SettingsBadge>
                  {translate('auto.components.settings.RepositoryPane.currentSetup', 'Current')}
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
                  {translate('auto.components.settings.RepositoryPane.openSetup', 'Open')}
                </Button>
              ) : null}
              {canRemoveSetup ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setDeletingSetupId(setup.id)
                    await deleteProjectHostSetup({ setupId: setup.id })
                    setDeletingSetupId(null)
                  }}
                >
                  {translate('auto.components.settings.RepositoryPane.removeSetup', 'Remove')}
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>
      {selectedProjectHostSetup ? (
        <RepositoryHostSetupActions
          repoDisplayName={repo.displayName}
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
