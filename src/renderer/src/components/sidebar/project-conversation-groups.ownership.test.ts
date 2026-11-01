import { describe, expect, it } from 'vitest'
import { buildConversationProjectGroups } from './project-conversation-groups'
import {
  conversationRepos,
  conversationWorktrees,
  conversationSessions
} from './ProjectConversationList.test-fixture'
import { MIXED_FOLDER } from '../../../../shared/folder-workspace-host-routing.test-fixture'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildAiVaultSessionProjectById } from '../right-sidebar/ai-vault-session-projects'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const localFolder = {
  ...MIXED_FOLDER,
  id: 'notes',
  name: 'Notes',
  folderPath: '/notes',
  executionHostId: 'local' as const
}
const remoteFolder = { ...localFolder, executionHostId: 'runtime:remote' as const }
function chat(id: string, host: ExecutionHostId, workspaceId = 'folder:notes'): AiVaultSession {
  return {
    ...conversationSessions[0]!,
    id,
    sessionId: id,
    executionHostId: host,
    cwd: '/notes',
    structuredSession: { sessionId: id, workspaceId }
  }
}
function groups(overrides: Partial<Parameters<typeof buildConversationProjectGroups>[0]> = {}) {
  const args = {
    sessions: [],
    sessionProjects: new Map(),
    repos: [],
    worktrees: [],
    folders: [],
    catalog: { projects: [], setups: [] },
    order: 'recent' as const,
    activeWorkspaceId: null,
    ...overrides
  }
  const sessionProjects = buildAiVaultSessionProjectById({
    folderWorkspaces: args.folders,
    repos: args.repos,
    worktrees: args.worktrees,
    projectHostSetupProjection: args.catalog,
    sessions: args.sessions
  })
  return buildConversationProjectGroups({ ...args, sessionProjects })
}

describe('project conversation ownership', () => {
  it('keeps same-path folder conversations and their new-chat targets separate on each host', () => {
    const result = groups({
      sessions: [chat('local', 'local'), chat('remote', 'runtime:remote')],
      folders: [localFolder, remoteFolder]
    })
    expect(result).toHaveLength(2)
    expect(new Set(result.map((group) => group.key)).size).toBe(2)
    for (const group of result) {
      expect(group.workspaceId).toBe('folder:notes')
      expect(group.executionHostId).toBe(group.sessions[0]!.executionHostId)
      expect(group.sessions).toHaveLength(1)
    }
  })
  it('shows catalog folders before their first chat and limits empty placeholders to the selected host', () => {
    const result = groups({
      folders: [localFolder, remoteFolder],
      executionHostScope: 'local'
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      label: 'Notes',
      sessions: [],
      workspaceId: folderWorkspaceToWorktree(localFolder).id,
      executionHostId: 'local'
    })
  })
  it('retains orphan history without offering a fabricated stored workspace as a new-chat target', () => {
    const result = groups({ sessions: [chat('lost', 'local', 'folder:missing')] })
    expect(result).toHaveLength(1)
    expect(result[0]!.sessions).toHaveLength(1)
    expect(result[0]!.workspaceId).toBeUndefined()
  })
  it('qualifies same-ID repository placeholders and chooses each host own workspace', () => {
    const repos = [
      conversationRepos[0]!,
      { ...conversationRepos[0]!, executionHostId: 'runtime:remote' as const }
    ]
    const worktrees = [
      { ...conversationWorktrees[0]!, hostId: 'local' as const },
      { ...conversationWorktrees[0]!, hostId: 'runtime:remote' as const }
    ]
    const result = groups({
      repos,
      worktrees,
      catalog: projectHostSetupProjectionFromRepos(repos),
      activeWorkspaceId: worktrees[1]!.id,
      activeExecutionHostId: 'runtime:remote'
    })
    expect(result).toHaveLength(2)
    expect(new Set(result.map((group) => group.executionHostId))).toEqual(
      new Set(['local', 'runtime:remote'])
    )
    expect(result.every((group) => group.workspaceId === worktrees[0]!.id)).toBe(true)
  })
  it('places a canonical owner in the registered project group with its existing actions', () => {
    const repos = [conversationRepos[0]!]
    const result = groups({
      repos,
      catalog: projectHostSetupProjectionFromRepos(repos),
      sessions: [{ ...conversationSessions[0]!, projectOwnerKey: 'repo:orca' }]
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.repo?.id).toBe('orca')
    expect(result[0]?.sessions).toHaveLength(1)
  })
  it('does not guess a host for unqualified workspace twins', () => {
    const repos = [
      conversationRepos[0]!,
      { ...conversationRepos[0]!, executionHostId: 'runtime:remote' as const }
    ]
    const result = groups({
      repos,
      worktrees: [conversationWorktrees[0]!],
      catalog: projectHostSetupProjectionFromRepos(repos)
    })
    expect(result.every((group) => group.workspaceId === undefined)).toBe(true)
  })
})
