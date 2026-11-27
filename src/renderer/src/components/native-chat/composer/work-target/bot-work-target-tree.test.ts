import { beforeEach, describe, expect, it } from 'vitest'
import { BotSchema, type Bot } from '../../../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AgentJournalWorkTarget } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'
import { queuedMessageWithEdit } from '../../../../../../shared/native-chat/input/queued-messages/queued-message-edit'
import {
  projectQueuedMessageCards,
  queuedMessageCardSteers
} from '../../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { nativeChatComposerDraftLeftAfterSend } from '../../drafts/native-chat-composer-draft-comparison'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
import { handBackStructuredAgentSessionMessage } from '../../session/structured/delivery/structured-agent-session-message-hand-back'
import { buildBotWorkTargetTree, filterBotWorkTargetTree } from './bot-work-target-tree'

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName' | 'path'>): Repo {
  return {
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeWorktree(
  overrides: Partial<Worktree> & Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'path'>
): Worktree {
  return {
    hostId: 'local',
    instanceId: 'inst-1',
    branch: overrides.displayName,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function makeFolderWorkspace(
  overrides: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id' | 'name' | 'folderPath'>
): FolderWorkspace {
  return {
    projectGroupId: 'grp-ops',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeProjectGroup(
  overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id' | 'name'>
): ProjectGroup {
  return {
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeBot(id: string, folderWorkspaceId: string): Bot {
  return BotSchema.parse({
    id,
    name: 'HelperBot',
    hostId: 'local',
    folder: 'helper-bot',
    folderWorkspaceId,
    agent: 'codex',
    avatar: null,
    paused: false,
    notifications: {
      needsPermission: false,
      taskComplete: false,
      couldNotFinish: false
    },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: 'sess-bot-1',
    createdAt: 1,
    updatedAt: 1
  })
}

describe('bot work target tree launch-boundary policy', () => {
  const localRepo = makeRepo({
    id: 'repo-acme-local',
    displayName: 'acme-api',
    path: '/synth/local/acme-api',
    executionHostId: 'local'
  })
  const remoteRepo = makeRepo({
    id: 'repo-acme-remote',
    displayName: 'acme-api',
    path: '/srv/build/acme-api',
    executionHostId: 'runtime:env-build'
  })
  const connectedSshRepo = makeRepo({
    id: 'repo-edge-ssh',
    displayName: 'edge-gateway',
    path: '/srv/ssh/edge-gateway',
    executionHostId: 'ssh:box-live'
  })
  const offlineSshRepo = makeRepo({
    id: 'repo-staging',
    displayName: 'staging-api',
    path: '/srv/staging/api',
    executionHostId: 'ssh:box-staging'
  })
  const hiddenRepo = makeRepo({
    id: 'repo-hidden',
    displayName: 'secret-repo',
    path: '/synth/local/secret',
    executionHostId: 'local',
    hiddenAt: 100
  })
  const folderRepo = makeRepo({
    id: 'repo-notes',
    displayName: 'design-notes',
    path: '/synth/local/design-notes',
    kind: 'folder',
    executionHostId: 'local'
  })
  const verifiedEnvStatus: RuntimeEnvironmentStatus = {
    snapshot: {
      environmentId: 'env-build',
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 1,
      status: null,
      verification: 'verified',
      transport: 'ready'
    },
    status: null,
    checkedAt: 1
  }

  it('disables connected SSH Git projects while keeping their existing SSH workspaces selectable with instance identity', () => {
    const rows = buildBotWorkTargetTree({
      botHostId: 'local',
      repos: [localRepo, remoteRepo, connectedSshRepo, offlineSshRepo, hiddenRepo, folderRepo],
      worktreesByRepo: {
        'repo-acme-local': [
          makeWorktree({
            id: 'wt-child',
            repoId: 'repo-acme-local',
            instanceId: 'inst-local-child',
            displayName: 'feat/auth-fix',
            branch: 'feat/auth-fix',
            path: '/synth/local/acme-api-auth'
          }),
          makeWorktree({
            id: 'wt-main',
            repoId: 'repo-acme-local',
            instanceId: 'inst-local-main',
            displayName: 'main',
            branch: 'main',
            path: '/synth/local/acme-api',
            isMainWorktree: true
          }),
          makeWorktree({
            id: 'wt-archived',
            repoId: 'repo-acme-local',
            instanceId: 'inst-archived',
            displayName: 'archived-exp',
            path: '/synth/local/acme-api-old',
            isArchived: true
          })
        ],
        'repo-edge-ssh': [
          makeWorktree({
            id: 'wt-ssh-main',
            repoId: 'repo-edge-ssh',
            hostId: 'ssh:box-live',
            instanceId: 'inst-ssh-main',
            displayName: 'main',
            branch: 'main',
            path: '/srv/ssh/edge-gateway',
            isMainWorktree: true
          })
        ],
        'repo-staging': [
          makeWorktree({
            id: 'wt-staging-main',
            repoId: 'repo-staging',
            hostId: 'ssh:box-staging',
            instanceId: 'inst-staging-main',
            displayName: 'main',
            branch: 'main',
            path: '/srv/staging/api',
            isMainWorktree: true
          })
        ]
      },
      worktreeLineageById: {
        'wt-child': { parentWorktreeId: 'wt-main' }
      },
      folderWorkspaces: [
        makeFolderWorkspace({
          id: 'fw-bot-home',
          name: 'HelperBot',
          folderPath: '/synth/bots/helper',
          projectGroupId: 'grp-bots'
        }),
        makeFolderWorkspace({
          id: 'fw-runbooks',
          name: 'runbooks',
          folderPath: '/synth/local/runbooks',
          projectGroupId: 'grp-ops'
        }),
        makeFolderWorkspace({
          id: 'fw-archived',
          name: 'old-folder',
          folderPath: '/synth/local/old-folder',
          isArchived: true
        })
      ],
      projectGroups: [
        makeProjectGroup({ id: 'grp-bots', name: 'Bots', tabOrder: 0 }),
        makeProjectGroup({ id: 'grp-ops', name: 'Operations', tabOrder: 1 })
      ],
      bots: [makeBot('bot-1', 'fw-bot-home')],
      runtimeEnvironments: [{ id: 'env-build', name: 'Build Server' }],
      runtimeStatusByEnvironmentId: new Map([['env-build', verifiedEnvStatus]]),
      sshTargetLabels: new Map([
        ['box-live', 'Live SSH'],
        ['box-staging', 'Staging SSH']
      ]),
      sshConnectionStates: new Map([
        ['box-live', { status: 'connected' }],
        ['box-staging', { status: 'disconnected' }]
      ])
    })

    // Connected SSH Git project cannot create new worktrees, while its child existing worktree stays selectable.
    const sshProject = rows.find((row) => row.id === 'project:ssh:box-live:repo-edge-ssh')
    const sshChild = rows.find((row) => row.id === 'workspace:ssh:box-live:wt-ssh-main')
    expect(sshProject?.unavailableReason).toBe('ssh-project-unsupported')
    expect(sshChild?.unavailableReason).toBeUndefined()
    expect(sshChild?.target.workspaceInstanceId).toBe('inst-ssh-main')

    // Offline SSH host marks both the project and its child worktrees offline.
    expect(
      rows.find((row) => row.id === 'project:ssh:box-staging:repo-staging')?.unavailableReason
    ).toBe('offline')
    expect(
      rows.find((row) => row.id === 'workspace:ssh:box-staging:wt-staging-main')?.unavailableReason
    ).toBe('offline')

    // Hidden repos, archived rows, and bot homes are excluded.
    expect(rows.some((row) => row.id.includes('repo-hidden'))).toBe(false)
    expect(rows.some((row) => row.id.includes('wt-archived'))).toBe(false)
    expect(rows.some((row) => row.id.includes('fw-bot-home'))).toBe(false)

    // Multi-token search disambiguates same-name hosts and keeps parent project context.
    expect(filterBotWorkTargetTree(rows, 'build acme').map((row) => row.id)).toEqual([
      'project:runtime:env-build:repo-acme-remote'
    ])
    expect(filterBotWorkTargetTree(rows, 'acme auth').map((row) => row.id)).toEqual([
      'project:local:repo-acme-local',
      'workspace:local:wt-child'
    ])
  })
})

describe('workTarget draft persistence, hand-back recovery, and non-steerable queue projection', () => {
  const targetA: AgentJournalWorkTarget = {
    kind: 'project',
    hostId: 'local',
    repoId: 'repo-acme',
    repoKind: 'git',
    displayName: 'acme-api'
  }
  const targetB: AgentJournalWorkTarget = {
    kind: 'workspace',
    hostId: 'runtime:env-build',
    repoId: 'repo-acme',
    workspaceId: 'wt-auth',
    workspaceInstanceId: 'inst-auth-1',
    workspaceKind: 'git-worktree',
    displayName: 'feat/auth-fix',
    projectName: 'acme-api',
    hostLabel: 'Build Server'
  }

  beforeEach(() => {
    updateNativeChatComposerDraft(
      'bot-chat-a',
      { text: '', images: [], workTarget: null },
      'immediate'
    )
    updateNativeChatComposerDraft(
      'bot-chat-b',
      { text: '', images: [], workTarget: null },
      'immediate'
    )
  })

  it('isolates drafts, restores text + attachments + target on hand-back, preserves target on queued edits, and marks targeted queued cards non-steerable while working', () => {
    updateNativeChatComposerDraft('bot-chat-a', { workTarget: targetA }, 'immediate')
    expect(readNativeChatComposerDraft('bot-chat-a').workTarget).toEqual(targetA)
    expect(readNativeChatComposerDraft('bot-chat-b').workTarget).toBeUndefined()

    expect(
      nativeChatComposerDraftLeftAfterSend(
        { text: 'First\nSecond', images: [], workTarget: targetA },
        { text: 'First', images: [], workTarget: targetA }
      )
    ).toEqual({ text: '\nSecond', images: [] })

    expect(
      nativeChatComposerDraftLeftAfterSend(
        { text: '/compact', images: [], workTarget: targetA },
        { text: '/compact', images: [], workTarget: targetA },
        { preserveWorkTarget: true }
      )?.workTarget
    ).toEqual(targetA)

    const sessionId = 'sess-handback-1'
    const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
    updateNativeChatComposerDraft(scopeKey, { text: '', images: [], workTarget: null }, 'immediate')
    handBackStructuredAgentSessionMessage(sessionId, 'op-fail', {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Inspect screenshot [Image #1]' },
        { type: 'image-ref', path: '/synth/uploads/screen.png' }
      ],
      workTarget: targetB
    })
    const restored = readNativeChatComposerDraft(scopeKey)
    expect(restored.workTarget).toEqual(targetB)
    expect(restored.images).toEqual([
      { id: 'returned-op-fail-1', path: '/synth/uploads/screen.png' }
    ])
    expect(restored.text).toContain('Inspect screenshot')

    const edited = queuedMessageWithEdit(
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Original queued prompt' }],
        workTarget: targetB
      },
      { text: 'Updated queued prompt' }
    )
    expect(edited.ok).toBe(true)
    if (edited.ok) {
      expect(edited.body.workTarget).toEqual(targetB)
    }

    const cards = projectQueuedMessageCards(
      [
        {
          messageId: 'q-targeted',
          position: 1,
          state: 'waiting',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Run in auth workspace' }],
            workTarget: targetB
          }
        },
        {
          messageId: 'q-plain',
          position: 2,
          state: 'waiting',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Plain steer follow-up' }]
          }
        }
      ],
      [],
      { agentWorking: true, queuePaused: false }
    )
    expect(cards[0]?.waitsForAgent).toBe(true)
    expect(queuedMessageCardSteers(cards[0]!)).toBe(false)
    expect(cards[1]?.waitsForAgent).toBeUndefined()
    expect(queuedMessageCardSteers(cards[1]!)).toBe(true)
  })
})
