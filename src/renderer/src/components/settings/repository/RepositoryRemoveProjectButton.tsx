import {
  sameRemovalCatalog,
  type SettingsProjectRemoval,
  type RemovalContextRepo,
  getRemoveProjectDescription
} from './settings-project-removal-description'

export type { SettingsProjectRemoval } from './settings-project-removal-description'

import type { SettingsProjectRemovalScope } from '../settings-project-list'
import type { Repo } from '../../../../../shared/repo-types'
import type { AppState } from '@/store/types'
import { selectRuntimeAwareSshTargetLabel } from '@/store/slices/runtime-environment-ssh-selectors'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { buildProjectGroups } from '../../../../../shared/project-grouping'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import { getProjectSectionRepoLookup } from '../../../../../shared/project-section-reveal'
import { getRecipeVmSshTargetForHost } from '@/lib/recipe-vm-managed-host'
import {
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '@/store/workspace-record-selectors'

import type { WorktreePurgeTarget } from '@/store/slices/worktree-helpers'
import { getProjectGroupingModelFromState } from '@/store/project-host-setup-selector'
import { getRepoRowIdentity } from '@/store/slices/repo-host-identity'
import { worktreeMatchesHost } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { getPtyExecutionHost } from '../../../../../shared/terminal-execution-host'
import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/unified-tab-host-ownership'
import { lastViewUnsavedFiles } from '@/components/editor/removal-unsaved-editor-files'
import {
  getExecutionHostLabel,
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId,
  type ExecutionHostId,
  isRuntimeOwnedSshTargetId,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host'
import { useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'

import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { SearchableSetting } from '../SearchableSetting'
import { translate } from '@/i18n/i18n'

export { getRemoveProjectDescription } from './settings-project-removal-description'

/** Address closure is operation-local; physical rows describe consequences, never add calls. */
export function prepareSettingsProjectRemoval(
  state: AppState,
  repo: RemovalContextRepo,
  scope: SettingsProjectRemovalScope,
  selectionKey: string | undefined,
  setups?: readonly ProjectHostSetup[]
): SettingsProjectRemoval {
  const lookup = getProjectSectionRepoLookup(state.repos)
  const currentGroup = selectionKey?.startsWith('project:')
    ? buildProjectGroups(getProjectGroupingModelFromState(state)).find(
        (group) => group.key === selectionKey
      )
    : undefined
  const seeds: readonly ProjectHostSetup[] = selectionKey?.startsWith('project:')
    ? (currentGroup?.registrations ?? [])
    : (setups ?? [
        {
          ...repo,
          id: repo.id,
          repoId: repo.id,
          hostId: getRepoExecutionHostId(repo),
          projectId: '',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 0,
          updatedAt: 0
        }
      ])
  const addresses = new Map<string, ProjectHostSetup>()
  const hostsByRaw = new Map<string, Map<ExecutionHostId, ProjectHostSetup>>()
  for (const setup of seeds) {
    if (!setup.repoId.trim()) {
      continue
    }
    const key = `${setup.hostId}\0${setup.repoId}`
    if (!addresses.has(key)) {
      addresses.set(key, setup)
      const hosts = hostsByRaw.get(setup.repoId) ?? new Map<ExecutionHostId, ProjectHostSetup>()
      hosts.set(setup.hostId, setup)
      hostsByRaw.set(setup.repoId, hosts)
    }
  }
  const members: Repo[] = []
  const seen = new Set<string>()
  const summaries = new Map<string, { count: number; host: ExecutionHostId }>()
  for (const member of state.repos) {
    const host = getRepoExecutionHostId(member)
    const summary = summaries.get(member.id)
    summaries.set(member.id, { count: (summary?.count ?? 0) + 1, host })
    const identity = getRepoRowIdentity(member)
    if (addresses.has(`${host}\0${member.id}`) && !seen.has(identity)) {
      seen.add(identity)
      members.push(member)
    }
  }
  const recipeHosts = new Set<ExecutionHostId>(
    state.runtimeEnvironments.flatMap((environment) => {
      const host = toRuntimeExecutionHostId(environment.id)
      return getRecipeVmSshTargetForHost([environment], host) ? [host] : []
    })
  )
  let hasVm = false
  const consequences = new Set<string>()
  const identities: string[] = []
  const names: string[] = []
  for (const member of members) {
    const host = getRepoExecutionHostId(member)
    const endpoint = parseExecutionHostId(host)
    const connection = getRepoSshConnectionId(member)
    const sshLabel =
      connection &&
      selectRuntimeAwareSshTargetLabel(
        state,
        endpoint?.kind === 'runtime' ? endpoint.environmentId : null,
        connection
      )
    const hostLabel =
      endpoint?.kind === 'runtime' && sshLabel
        ? `${getExecutionHostLabel(host)} · ${sshLabel}`
        : sshLabel || getExecutionHostLabel(host)
    names.push(`${hostLabel}: ${member.path}`)
    identities.push(JSON.stringify([getRepoRowIdentity(member), member.path, hostLabel]))
    hasVm ||= recipeHosts.has(host) || isRuntimeOwnedSshTargetId(connection)
    if (connection && !isRuntimeOwnedSshTargetId(connection)) {
      consequences.add(
        translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionSsh',
          'This only removes {{name}} from Orca. Its files stay on {{host}} — re-add that SSH host to recover it.',
          { name: member.displayName, host: hostLabel }
        )
      )
    }
  }
  const targets = new Map<string, WorktreePurgeTarget>()
  const associations = new Map<
    string,
    { affected: Set<ExecutionHostId>; other: Set<ExecutionHostId> }
  >()
  const listed = selectWorktreesByRepo(state)
  const detected = selectDetectedWorktreesByRepo(state)
  // Each touched raw bucket is partitioned once, even when H contains many of its registrations.
  for (const [raw, hosts] of hostsByRaw) {
    const summary = summaries.get(raw)
    for (const row of [...(listed[raw] ?? []), ...(detected[raw]?.worktrees ?? [])]) {
      const owner = row.runtimeOwnerEnvironmentId
        ? toRuntimeExecutionHostId(row.runtimeOwnerEnvironmentId)
        : (row.hostId ?? (summary?.count === 1 ? summary.host : 'local'))
      const included =
        hosts.has(owner) &&
        worktreeMatchesHost(row, owner, {
          unhostedWorktreesMatchHost: owner === 'local' || summary?.count === 1
        })
      const association = associations.get(row.id) ?? {
        affected: new Set<ExecutionHostId>(),
        other: new Set<ExecutionHostId>()
      }
      const aliases = included ? association.affected : association.other
      aliases.add(owner)
      if (row.hostId) {
        aliases.add(row.hostId)
      }
      associations.set(row.id, association)
      if (included) {
        const hostId = row.hostId ?? owner
        targets.set(`${hostId}\0${row.id}`, { id: row.id, hostId })
        hasVm ||= row.ephemeralVmCheckoutMode === 'provisioned-root'
      }
    }
  }
  const owns = (id: string, host: ExecutionHostId | 'foreign' | null): boolean => {
    const association = associations.get(id)
    return Boolean(
      association?.affected.size &&
      (host
        ? host !== 'foreign' && association.affected.has(host) && !association.other.has(host)
        : association.other.size === 0)
    )
  }
  const tabs = new Set<string>()
  for (const [id, association] of associations) {
    if (!association.affected.size) {
      continue
    }
    for (const tab of state.tabsByWorktree[id] ?? []) {
      const ptys = state.ptyIdsByTabId[tab.id] ?? []
      if (ptys.some((pty) => owns(id, getPtyExecutionHost(pty)))) {
        tabs.add(tab.id)
      }
    }
  }
  const closedFileIds = new Set<string>()
  for (const file of state.openFiles) {
    // A paired file's endpoint is stronger than an endpoint-local nested SSH target spelling.
    const host = file.runtimeEnvironmentId
      ? toRuntimeExecutionHostId(file.runtimeEnvironmentId)
      : hasOpenFileExecutionHostEvidence(file)
        ? getOpenFileExecutionHostId(file)
        : null
    if (owns(file.worktreeId, host)) {
      closedFileIds.add(file.id)
      if (file.markdownPreviewSourceFileId) {
        closedFileIds.add(file.markdownPreviewSourceFileId)
      }
    }
  }
  const dirty = lastViewUnsavedFiles(state, closedFileIds)
    .map((file) => file.id)
    .sort()
  if (hasVm) {
    consequences.add(
      translate(
        'auto.components.sidebar.RemoveFolderDialog.removeDescriptionVmRecipe',
        'This removes {{name}} from Orca. Its VM recipe determines whether the environment and its files are permanently deleted.',
        { name: repo.displayName }
      )
    )
  } else if (
    consequences.size === 0 &&
    members.length &&
    members.every((member) => getRepoExecutionHostId(member) === 'local')
  ) {
    consequences.add(
      translate(
        'auto.components.sidebar.RemoveFolderDialog.removeDescriptionLocal',
        'This only removes {{name}} from Orca. It is still on your disk.',
        { name: repo.displayName }
      )
    )
  }
  if (tabs.size) {
    consequences.add(
      translate(
        'auto.components.sidebar.RemoveFolderDialog.openTerminalWarning',
        '{{count}} open terminals in this project will be closed.',
        {
          count: tabs.size,
          defaultValue_one: '{{count}} open terminal in this project will be closed.'
        }
      )
    )
  }
  const description = [
    scope === 'checkout' && members.length > 1
      ? translate('settings.projectGrouping.removeAddress', 'Remove these checkouts from Orca.')
      : getRemoveProjectDescription(scope, repo),
    ...names.sort(),
    ...[...consequences].sort()
  ].join(' ')
  return {
    description,
    signature: JSON.stringify([
      selectionKey,
      scope,
      [...addresses.keys()].sort().map((key) => [key, lookup.has(key)]),
      identities.sort(),
      description,
      dirty
    ]),
    addresses: [...addresses.values()],
    targets: [...targets.values()],
    closedFileIds
  }
}

export function useSettingsProjectRemovalDescription(
  repo: Repo,
  scope: SettingsProjectRemovalScope,
  selectionKey: string | undefined,
  setups?: readonly ProjectHostSetup[]
) {
  const { id, path, displayName, executionHostId, connectionId } = repo
  const fallbackSetups = selectionKey?.startsWith('project:') ? undefined : setups
  const select = useMemo(() => {
    const context: RemovalContextRepo = { id, path, displayName, executionHostId, connectionId }
    let previous: readonly unknown[] | undefined
    let observedRepos: AppState['repos'] | undefined
    let materialRepos: AppState['repos'] | undefined
    let value = { description: '', signature: '' }
    return (state: AppState) => {
      if (observedRepos !== state.repos) {
        if (!materialRepos || !sameRemovalCatalog(materialRepos, state.repos)) {
          materialRepos = state.repos
        }
        observedRepos = state.repos
      }
      const lookup = getProjectSectionRepoLookup(materialRepos ?? state.repos)
      const inputs = [
        lookup,
        materialRepos,
        state.projects,
        state.projectHostSetups,
        state.settings?.projectGroupingMode,
        state.settings?.projectGroupingOverrides,
        state.runtimeEnvironments,
        state.sshStateByEnvironment,
        state.sshTargetLabels,
        state.removedSshTargetLabels,
        state.worktreesByRepo,
        state.detectedWorktreesByRepo,
        state.tabsByWorktree,
        state.ptyIdsByTabId,
        state.openFiles,
        state.editorDrafts,
        state.editorBufferIdOf,
        state.editorBufferViews
      ]
      if (!previous || inputs.some((input, i) => !Object.is(input, previous?.[i]))) {
        previous = inputs
        const current = prepareSettingsProjectRemoval(
          state,
          context,
          scope,
          selectionKey,
          fallbackSetups
        )
        value = { description: current.description, signature: current.signature }
      }
      return value
    }
  }, [id, path, displayName, executionHostId, connectionId, scope, selectionKey, fallbackSetups])
  const value = useAppStore(useShallow(select))
  return value
}

export function RepositoryRemoveProjectButton({
  repo,
  description,
  confirmationKey,
  forceVisible,
  removeProject,
  readCurrentRemoval
}: {
  repo: Repo
  description: string
  confirmationKey: string
  forceVisible: boolean
  removeProject: (repoId: string, accepted?: SettingsProjectRemoval) => void
  readCurrentRemoval?: () => SettingsProjectRemoval
}) {
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  useEffect(() => setConfirmingRemove(null), [confirmationKey])
  const removeProjectLabel =
    confirmingRemove === confirmationKey ? 'Confirm Remove Project' : 'Remove Project'

  const handleRemoveProject = (repoId: string) => {
    const current = readCurrentRemoval?.()
    const currentKey = current?.signature ?? confirmationKey
    if (confirmingRemove === confirmationKey && currentKey === confirmationKey) {
      if (current) {
        removeProject(repoId, current)
      } else {
        removeProject(repoId)
      }
      setConfirmingRemove(null)
      return
    }

    setConfirmingRemove(currentKey === confirmationKey ? confirmationKey : null)
  }

  return (
    <SearchableSetting
      title={translate('auto.components.settings.RepositoryPane.0909e5d650', 'Remove Project')}
      description={description}
      keywords={[repo.displayName, 'delete', 'project', 'repository']}
      className="absolute top-0 right-0 z-10 w-auto max-w-none"
      forceVisible={forceVisible}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={confirmingRemove === confirmationKey ? 'destructive' : 'outline'}
            size="icon-sm"
            onClick={() => handleRemoveProject(repo.id)}
            onBlur={() => setConfirmingRemove(null)}
            aria-label={removeProjectLabel}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {removeProjectLabel}
        </TooltipContent>
      </Tooltip>
    </SearchableSetting>
  )
}
