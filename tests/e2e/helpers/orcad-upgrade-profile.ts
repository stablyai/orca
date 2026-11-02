/**
 * The profile a relay-era build (v1.4.218, the last before auto-conversion) leaves behind for an
 * SSH host: the target without a fence, its repository and remote folder workspace, and an editor
 * tab (optionally beside a terminal tab) in the host's session partition. Seeded into a stopped profile, so the next launch is the
 * user's first on a converting build.
 */
import type { FolderWorkspace } from '../../../src/shared/folder-workspace-types'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import type { Repo } from '../../../src/shared/repo-types'
import type { SshTarget, SshTargetCreateInput } from '../../../src/shared/ssh-types'
import { getDefaultWorkspaceSession } from '../../../src/shared/constants'
import { toSshExecutionHostId } from '../../../src/shared/execution-host'
import { toAppSshPtyId } from '../../../src/shared/ssh-pty-id'
import { normalizeSshTarget } from '../../../src/main/persistence/leasing-ssh-ptys/ssh-normalization'
import { mutateStoppedProfileState } from './persisted-profile-state'

export type RelayEraProfile = {
  targetId: string
  repoId: string
  worktreeId: string
  repoPath: string
  folderPath: string
  sessionFilePath: string
  /** Set only when the seed asked for a relay-era terminal tab. */
  terminalTabId: string | null
  terminalLeafId: string
  /** Each parked pane's local-only scrollback, by leaf; empty unless the seed asked for it. */
  parkedScrollbackByLeafId: Record<string, string>
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
  paths: { repoPath: string; folderPath: string },
  options: {
    terminalTab?: boolean
    /** #30126: two split panes whose parked scrollback together outgrows the 768 KB manifest. */
    parkedScrollback?: boolean
    targetId?: string
    /** COMPAT(legacy-relay-bridge): the terminal tab still runs this PTY in the host's relay. */
    relayPtyId?: string
  } = {}
): RelayEraProfile {
  const now = Date.now()
  const targetId = options.targetId ?? `ssh-upgrade-${now}`
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
  const terminalTabId = options.terminalTab || options.relayPtyId ? `terminal-upgrade-${now}` : null
  const terminalLeafId = '00000000-0000-4000-8000-000000000001'
  const parkedLeafId = '00000000-0000-4000-8000-000000000002'
  // Under the 512 KB per-pane session cap, so the profile load keeps every byte.
  const parkedOutput = (leafId: string): string =>
    Array.from({ length: 9_000 }, (_, line) => `${leafId} parked ${line}\r\n`).join('')
  const parkedScrollbackByLeafId: Record<string, string> =
    terminalTabId && options.parkedScrollback
      ? {
          [terminalLeafId]: parkedOutput(terminalLeafId),
          [parkedLeafId]: parkedOutput(parkedLeafId)
        }
      : {}
  const appPtyId = options.relayPtyId ? toAppSshPtyId(targetId, options.relayPtyId) : null
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
        },
        ...(terminalTabId
          ? [
              {
                id: terminalTabId,
                entityId: terminalTabId,
                groupId,
                worktreeId,
                executionHostId: hostId,
                contentType: 'terminal',
                label: 'Terminal 1',
                customLabel: null,
                color: null,
                sortOrder: 2,
                createdAt: now
              }
            ]
          : [])
      ]
    },
    ...(terminalTabId
      ? {
          // Without a relay PTY the tab names no live session by the time this build runs.
          tabsByWorktree: {
            [worktreeId]: [
              {
                id: terminalTabId,
                ptyId: appPtyId,
                worktreeId,
                title: 'Terminal 1',
                defaultTitle: 'Terminal 1',
                customTitle: null,
                color: null,
                sortOrder: 2,
                createdAt: now
              }
            ]
          },
          ptyIdsByTabId: { [terminalTabId]: appPtyId ? [appPtyId] : [] },
          ...(options.parkedScrollback
            ? { localOnlyScrollbackByTabId: { [terminalTabId]: parkedScrollbackByLeafId } }
            : {}),
          terminalLayoutsByTabId: {
            [terminalTabId]: {
              root: options.parkedScrollback
                ? {
                    type: 'split',
                    direction: 'vertical',
                    first: { type: 'leaf', leafId: terminalLeafId },
                    second: { type: 'leaf', leafId: parkedLeafId }
                  }
                : { type: 'leaf', leafId: terminalLeafId },
              activeLeafId: terminalLeafId,
              expandedLeafId: null,
              ...(appPtyId ? { ptyIdsByLeafId: { [terminalLeafId]: appPtyId } } : {})
            }
          }
        }
      : {}),
    tabGroups: {
      [worktreeId]: [
        {
          id: groupId,
          worktreeId,
          activeTabId: tabId,
          tabOrder: terminalTabId ? [tabId, terminalTabId] : [tabId],
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
    if (options.relayPtyId && terminalTabId) {
      // As the relay-era client recorded the shell it left running when it quit.
      pushRow(state, 'sshRemotePtyLeases', {
        targetId,
        ptyId: options.relayPtyId,
        worktreeId,
        tabId: terminalTabId,
        leafId: terminalLeafId,
        state: 'detached',
        createdAt: now,
        updatedAt: now,
        lastDetachedAt: now
      })
    }
    const partitions = state.workspaceSessionsByHostId
    state.workspaceSessionsByHostId = {
      ...(partitions && typeof partitions === 'object' ? partitions : {}),
      [hostId]: session
    }
  })
  return {
    targetId,
    repoId: repo.id,
    worktreeId,
    repoPath: paths.repoPath,
    folderPath: paths.folderPath,
    sessionFilePath,
    terminalTabId,
    terminalLeafId,
    parkedScrollbackByLeafId
  }
}
