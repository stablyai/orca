import { z } from 'zod'
import { workspaceSessionStateSchema } from '../../../src/shared/workspace-session-schema'
import { worktreeWorkspaceKey } from '../../../src/shared/workspace-scope'
import { toSshExecutionHostId } from '../../../src/shared/execution-host'
import { mutateStoppedProfileState } from './persisted-profile-state'
import type { RelayEraProfile } from './orcad-upgrade-profile'
import { mergeWorktreeMetaForWrite } from '../../../src/main/persistence/loading-store/worktree-meta-write-normalization'

/** Released clients can leave cross-host parents, closed-pane resumes and stale local snapshots. */
export function seedRetainedUpgradeState(
  userDataDir: string,
  seeded: RelayEraProfile,
  parentPath: string
): void {
  mutateStoppedProfileState(userDataDir, (state) => {
    const records = z.record(z.string(), z.unknown())
    const parentRepo = z
      .array(z.object({ id: z.string(), path: z.string() }))
      .parse(state.repos)
      .find((repo) => repo.path === parentPath)
    if (!parentRepo) {
      throw new Error('Expected the desktop parent repository')
    }
    const parent = `${parentRepo.id}::${parentPath}`
    const partitions = z
      .record(z.string(), workspaceSessionStateSchema)
      .parse(state.workspaceSessionsByHostId)
    const hostId = toSshExecutionHostId(seeded.targetId)
    const host = partitions[hostId]
    if (!host || !seeded.terminalTabId) {
      throw new Error('Expected the relay-era host and terminal')
    }
    const local = workspaceSessionStateSchema.parse(state.workspaceSession)
    local.tabsByWorktree[seeded.worktreeId] = structuredClone(
      host.tabsByWorktree[seeded.worktreeId]
    )
    local.terminalLayoutsByTabId = {
      ...local.terminalLayoutsByTabId,
      ...structuredClone(host.terminalLayoutsByTabId)
    }
    local.terminalTopologyRevisionByRepoId = {
      ...local.terminalTopologyRevisionByRepoId,
      [seeded.repoId]: 1
    }
    host.terminalTopologyRevisionByRepoId = {
      ...host.terminalTopologyRevisionByRepoId,
      [seeded.repoId]: 2
    }
    const tabId = 'closed-agent-tab'
    host.sleepingAgentSessionsByPaneKey = {
      [`${tabId}:closed-leaf`]: {
        paneKey: `${tabId}:closed-leaf`,
        tabId,
        worktreeId: seeded.worktreeId,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'retained-closed-session' },
        prompt: 'Retained only',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        connectionId: seeded.targetId,
        origin: 'quit'
      }
    }
    state.workspaceSession = local
    state.workspaceSessionsByHostId = partitions
    const capture = { source: 'cwd-context', confidence: 'inferred' }
    state.worktreeMeta = {
      ...records.parse(state.worktreeMeta),
      [seeded.worktreeId]: mergeWorktreeMetaForWrite(
        undefined,
        {},
        { instanceId: 'remote-instance', hostId }
      ),
      [parent]: mergeWorktreeMetaForWrite(
        undefined,
        {},
        { instanceId: 'desktop-instance', hostId: 'local' }
      )
    }
    state.worktreeLineageById = {
      ...records.parse(state.worktreeLineageById),
      [seeded.worktreeId]: {
        worktreeId: seeded.worktreeId,
        worktreeInstanceId: 'remote-instance',
        parentWorktreeId: parent,
        parentWorktreeInstanceId: 'desktop-instance',
        origin: 'cli',
        capture,
        createdAt: 1
      }
    }
    const child = worktreeWorkspaceKey(seeded.worktreeId)
    state.workspaceLineageByChildKey = {
      ...records.parse(state.workspaceLineageByChildKey),
      [child]: {
        childWorkspaceKey: child,
        childInstanceId: 'remote-instance',
        parentWorkspaceKey: worktreeWorkspaceKey(parent),
        parentInstanceId: 'desktop-instance',
        origin: 'cli',
        capture,
        createdAt: 1
      }
    }
  })
}
