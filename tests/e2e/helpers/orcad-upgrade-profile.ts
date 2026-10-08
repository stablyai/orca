/**
 * The profile a relay-era build (v1.4.218, the last before auto-conversion) leaves behind for an
 * SSH host: the target without a fence, its repository and remote folder workspace, and an editor
 * tab in the host's session partition. Seeded into a stopped profile, so the next launch is the
 * user's first on a converting build.
 */
import type { FolderWorkspace } from '../../../src/shared/folder-workspace-types'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import type { Repo } from '../../../src/shared/repo-types'
import type { SshTarget, SshTargetCreateInput } from '../../../src/shared/ssh-types'
import { getDefaultWorkspaceSession } from '../../../src/shared/constants'
import { toSshExecutionHostId } from '../../../src/shared/execution-host'
import { normalizeSshTarget } from '../../../src/main/persistence/leasing-ssh-ptys/ssh-normalization'
import { mutateStoppedProfileState } from './persisted-profile-state'

export type RelayEraProfile = {
  targetId: string
  worktreeId: string
  repoPath: string
  folderPath: string
  sessionFilePath: string
}

function pushRow(state: Record<string, unknown>, field: string, row: unknown): void {
  const rows = state[field]
  state[field] = [...(Array.isArray(rows) ? rows : []), row]
}

function nextGeneration(state: Record<string, unknown>): number {
  const targets = Array.isArray(state.sshTargets) ? state.sshTargets : []
  const counter =
    typeof state.sshTargetGenerationCounter === 'number' ? state.sshTargetGenerationCounter : 0
  return (
    Math.max(
      counter,
      ...targets.map((target) => (typeof target?.generation === 'number' ? target.generation : 0))
    ) + 1
  )
}

/** As SshConnectionStore.addTarget registers it: config alias, manual source, fresh generation. */
function pushRelayEraTarget(
  state: Record<string, unknown>,
  input: SshTargetCreateInput,
  targetId: string,
  extra: Partial<SshTarget> = {}
): void {
  const generation = nextGeneration(state)
  state.sshTargetGenerationCounter = generation
  pushRow(
    state,
    'sshTargets',
    normalizeSshTarget({
      ...input,
      id: targetId,
      configHost: input.host,
      source: 'manual',
      generation,
      ...extra
    })
  )
}

/** Only the relay-era target, for a cell that adds its own project once connected. */
export function seedRelayEraTarget(
  userDataDir: string,
  input: SshTargetCreateInput,
  extra: Partial<SshTarget> = {}
): string {
  const targetId = `ssh-upgrade-${Date.now()}`
  mutateStoppedProfileState(userDataDir, (state) =>
    pushRelayEraTarget(state, input, targetId, extra)
  )
  return targetId
}

export function seedRelayEraProfile(
  userDataDir: string,
  input: SshTargetCreateInput,
  paths: { repoPath: string; folderPath: string }
): RelayEraProfile {
  const now = Date.now()
  const targetId = `ssh-upgrade-${now}`
  const hostId = toSshExecutionHostId(targetId)
  const repo: Repo = {
    id: `repo-upgrade-${now}`,
    path: paths.repoPath,
    displayName: 'orcad upgrade E2E',
    badgeColor: '#737373',
    addedAt: now,
    connectionId: targetId
  }
  const group: ProjectGroup = {
    id: `group-upgrade-${now}`,
    name: 'orcad upgrade folders',
    parentPath: paths.folderPath,
    connectionId: targetId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: now,
    updatedAt: now
  }
  const folder: FolderWorkspace = {
    id: `folder-upgrade-${now}`,
    projectGroupId: group.id,
    name: 'orcad upgrade folder',
    folderPath: paths.folderPath,
    connectionId: targetId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now
  }
  const worktreeId = `${repo.id}::${repo.path}`
  const sessionFilePath = `${paths.repoPath}/README.md`
  const tabId = `tab-upgrade-${now}`
  const groupId = `tab-group-upgrade-${now}`
  // The shape the relay-era renderer persisted for one open editor (CI capture of a live profile).
  const session = {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      [worktreeId]: [
        {
          filePath: sessionFilePath,
          relativePath: 'README.md',
          worktreeId,
          language: 'markdown',
          runtimeEnvironmentId: null
        }
      ]
    },
    activeFileIdByWorktree: { [worktreeId]: sessionFilePath },
    activeTabTypeByWorktree: { [worktreeId]: 'editor' },
    activeTabIdByWorktree: { [worktreeId]: tabId },
    unifiedTabs: {
      [worktreeId]: [
        {
          id: tabId,
          entityId: sessionFilePath,
          groupId,
          worktreeId,
          executionHostId: hostId,
          contentType: 'editor',
          label: 'README.md',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: now,
          lastFocusedAt: now,
          isPreview: false
        }
      ]
    },
    tabGroups: {
      [worktreeId]: [
        {
          id: groupId,
          worktreeId,
          activeTabId: tabId,
          tabOrder: [tabId],
          recentTabIds: [tabId]
        }
      ]
    },
    tabGroupLayouts: { [worktreeId]: { type: 'leaf', groupId } },
    activeGroupIdByWorktree: { [worktreeId]: groupId }
  }
  mutateStoppedProfileState(userDataDir, (state) => {
    pushRelayEraTarget(state, input, targetId)
    pushRow(state, 'repos', repo)
    pushRow(state, 'projectGroups', group)
    pushRow(state, 'folderWorkspaces', folder)
    const partitions = state.workspaceSessionsByHostId
    state.workspaceSessionsByHostId = {
      ...(partitions && typeof partitions === 'object' ? partitions : {}),
      [hostId]: session
    }
  })
  return {
    targetId,
    worktreeId,
    repoPath: paths.repoPath,
    folderPath: paths.folderPath,
    sessionFilePath
  }
}
