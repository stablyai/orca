import { describe, expect, it } from 'vitest'
import type { WorkspaceLineage, WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { resolveWorkspaceLineageParents } from '../worktree/lineage/workspace-lineage-graph'
import { worktreeWorkspaceKey } from '../workspace/identity/workspace-scope'
import {
  agentSessionAttentionNews,
  type AgentSessionAttentionEdge
} from '../agent-session/view/agent-session-attention'
import {
  agreedBotWorkspacePlace,
  botSpawnedChatNews,
  botWorkspacePlace,
  isBotSpawnedAgent,
  isBotSpawnedAgentNewsMuted
} from './bot-spawned-agent-mute'

function row(id: string): Worktree {
  return {
    id,
    instanceId: `${id}#1`,
    repoId: 'repo',
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: `/work/${id}`,
    head: 'abc123',
    branch: id,
    isBare: false,
    isMainWorktree: false
  }
}

function underFolder(
  child: string,
  folderId: string,
  capture: WorkspaceLineage['capture'],
  origin: WorkspaceLineage['origin']
): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(child),
    childInstanceId: `${child}#1`,
    parentWorkspaceKey: `folder:${folderId}`,
    parentInstanceId: null,
    origin,
    capture,
    createdAt: 1
  }
}

const fromBot = { source: 'orchestration-context', confidence: 'explicit' } as const
const rows = [
  row('folder:bot-home'),
  row('folder:user-folder'),
  row('worker'),
  row('no-parent-handoff'),
  row('adopted'),
  row('helper'),
  row('user-task'),
  row('plain')
]
const folderRecords: Record<string, WorkspaceLineage> = {
  // worker-start --worktree new-child from the bot's chat.
  worker: underFolder('worker', 'bot-home', fromBot, 'orchestration'),
  // `worktree create --no-parent` from the bot's home: the host records the bot as parent.
  'no-parent-handoff': underFolder('no-parent-handoff', 'bot-home', fromBot, 'orchestration'),
  // "Take over a workspace" moves a workspace under the bot's home.
  adopted: underFolder(
    'adopted',
    'bot-home',
    { source: 'bot-hand-over', confidence: 'explicit' },
    'manual'
  ),
  'user-task': underFolder(
    'user-task',
    'user-folder',
    { source: 'manual-action', confidence: 'explicit' },
    'manual'
  )
}
// A worker's own child worktree.
const worktreeLineage: Record<string, WorktreeLineage> = {
  helper: {
    worktreeId: 'helper',
    worktreeInstanceId: 'helper#1',
    parentWorktreeId: 'worker',
    parentWorktreeInstanceId: 'worker#1',
    origin: 'orchestration',
    capture: fromBot,
    createdAt: 1
  }
}
const byIdentity = new Map(rows.map((item) => [getWorktreeHostIdentity(item), item]))
const parents = resolveWorkspaceLineageParents(
  worktreeLineage,
  byIdentity,
  undefined,
  (item) => folderRecords[item.id]
)
const parentIdentityOf = (identity: string): string | undefined => {
  const parent = parents.get(identity)
  return parent ? getWorktreeHostIdentity(parent) : undefined
}
const homes = new Set([getWorktreeHostIdentity(row('folder:bot-home'))])
const placeOf = (id: string) =>
  botWorkspacePlace(getWorktreeHostIdentity(row(id)), parentIdentityOf, homes)

describe('botWorkspacePlace', () => {
  it.each([
    ['folder:bot-home', 'home'],
    ['worker', 'below-home'],
    ['no-parent-handoff', 'below-home'],
    ['adopted', 'below-home'],
    ['helper', 'below-home'],
    ['folder:user-folder', null],
    ['user-task', null],
    ['plain', null]
  ])('%s is %s', (id, place) => {
    expect(placeOf(id)).toBe(place)
  })
})

describe('agreedBotWorkspacePlace', () => {
  it('keeps an id loud unless every same-id copy on every host has the place', () => {
    const twin = getWorktreeHostIdentity({ ...row('worker'), hostId: 'ssh:other-box' })
    const places = [placeOf('worker'), botWorkspacePlace(twin, parentIdentityOf, homes)]
    expect(places).toEqual(['below-home', null])
    expect(agreedBotWorkspacePlace(places)).toBe(null)
    expect(agreedBotWorkspacePlace(['below-home', 'below-home'])).toBe('below-home')
    expect(agreedBotWorkspacePlace([])).toBe(null)
  })
})

describe('isBotSpawnedAgent', () => {
  it("leaves the bot's own chats in its home to the person", () => {
    expect(isBotSpawnedAgent('home', () => false)).toBe(false)
  })

  it('counts a dispatched worker running in the home', () => {
    expect(isBotSpawnedAgent('home', () => true)).toBe(true)
  })

  it('counts every agent below a home, and nothing outside one', () => {
    expect(isBotSpawnedAgent('below-home', () => false)).toBe(true)
    expect(isBotSpawnedAgent(null, () => true)).toBe(false)
  })
})

describe('isBotSpawnedAgentNewsMuted', () => {
  const on = { muteBotSpawnedAgents: true, muteBotSpawnedPermissionPrompts: false }
  const both = { muteBotSpawnedAgents: true, muteBotSpawnedPermissionPrompts: true }
  const spawned = () => true

  it.each([
    ['a finished turn', { agentState: 'done' }],
    ['a title-only stop', { agentState: undefined }],
    ['a question', { agentState: 'waiting', toolName: 'AskUserQuestion' }],
    ['a Codex question', { agentState: 'waiting', toolName: 'request_user_input' }]
  ])('mutes %s', (_label, news) => {
    expect(isBotSpawnedAgentNewsMuted(on, news, spawned)).toBe(true)
  })

  it.each([
    ['a hook permission request', { agentState: 'waiting', toolName: 'Bash' }],
    ['a blocked prompt', { agentState: 'blocked' }],
    [
      'an approval title over a question tool',
      { agentState: 'blocked', toolName: 'AskUserQuestion' }
    ]
  ])('keeps %s loud by default', (_label, news) => {
    expect(isBotSpawnedAgentNewsMuted(on, news, spawned)).toBe(false)
    expect(isBotSpawnedAgentNewsMuted(both, news, spawned)).toBe(true)
  })

  it('keeps everything loud while the first switch is off', () => {
    const off = { muteBotSpawnedAgents: false, muteBotSpawnedPermissionPrompts: true }
    expect(isBotSpawnedAgentNewsMuted(off, { agentState: 'done' }, spawned)).toBe(false)
    expect(isBotSpawnedAgentNewsMuted(undefined, { agentState: 'done' }, spawned)).toBe(false)
  })

  it("keeps the bot's own sessions loud", () => {
    expect(isBotSpawnedAgentNewsMuted(both, { agentState: 'done' }, () => false)).toBe(false)
  })
})

describe('botSpawnedChatNews', () => {
  const on = { muteBotSpawnedAgents: true, muteBotSpawnedPermissionPrompts: false }
  const both = { muteBotSpawnedAgents: true, muteBotSpawnedPermissionPrompts: true }
  const scope = {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'worker',
    workspaceKind: 'git-worktree'
  } as const
  const completion = (
    outcome: 'success' | 'failure',
    awaitingUser?: true
  ): AgentSessionAttentionEdge => ({
    type: 'completion',
    completion: { scope, sessionId: 's', turnId: 't', outcome, completedAt: 1, awaitingUser }
  })
  const prompt = (asksOnlyQuestions?: true): AgentSessionAttentionEdge => ({
    type: 'prompt',
    prompt: { scope, sessionId: 's', promptId: 'p', raisedAt: 1, asksOnlyQuestions }
  })
  const mutedBy = (settings: typeof on, edge: AgentSessionAttentionEdge): boolean =>
    isBotSpawnedAgentNewsMuted(
      settings,
      botSpawnedChatNews(edge, agentSessionAttentionNews(edge)!.agentState),
      () => true
    )

  it.each([
    ['a failed turn that leaves a prompt waiting', completion('failure', true)],
    ['a settled turn that leaves a prompt waiting', completion('success', true)],
    ['a prompt that may be an approval', prompt()]
  ])('keeps %s loud by default', (_label, edge) => {
    expect(mutedBy(on, edge)).toBe(false)
    expect(mutedBy(both, edge)).toBe(true)
  })

  it.each([
    ['a failed turn', completion('failure')],
    ['a finished turn', completion('success')],
    ['a prompt of questions only', prompt(true)]
  ])('mutes %s', (_label, edge) => {
    expect(mutedBy(on, edge)).toBe(true)
  })
})
