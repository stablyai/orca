import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_LINKED_CWD_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { makeWorktree } from '../worktree-jump-palette-test-fixtures'

const mocks = vi.hoisted(() => ({
  owner: vi.fn<() => string | null>(() => 'local'),
  localCapabilities: vi.fn<() => readonly string[] | null>(() => []),
  state: { runtimeStatusByEnvironmentId: new Map<string, unknown>() }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  resolveStructuredAgentSessionOwner: mocks.owner
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.localCapabilities
}))
// The route's own feasibility is pinned elsewhere; this suite pins the host rule on top of it.
vi.mock('@/lib/agent-session-launch-plan', () => ({
  structuredAgentSessionLaunchFeasible: () => true
}))

import { resolveAiVaultSessionResumeInChatForWorkspace } from './ai-vault-session-resume-in-chat-workspace'

const PAIRED_WORKSPACE = 'repo-1::/srv/orca'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields eligibility reads are staged.
const codexSession = {
  id: 'codex-1',
  agent: 'codex',
  executionHostId: 'local',
  cwd: '/Users/me/orca',
  filePath: '/Users/me/.codex/sessions/rollout-1.jsonl',
  messageCount: 4,
  previewMessages: []
} as unknown as AiVaultSession

function resumeInChat(session: AiVaultSession = codexSession) {
  return resolveAiVaultSessionResumeInChatForWorkspace({
    session,
    resumeState: { blocked: true, worktreeId: null, usesSessionWorktree: false },
    activeWorkspaceId: PAIRED_WORKSPACE,
    targetState: { folderWorkspaces: [], projectGroups: [], repos: [], worktreesByRepo: {} },
    settings: {
      nativeChatProviders: EVERY_AGENT_CHAT
    }
  })
}

beforeEach(() => {
  mocks.localCapabilities.mockReturnValue([
    STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
  ])
  mocks.state.runtimeStatusByEnvironmentId = new Map([
    [
      'server-1',
      { status: { capabilities: [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY] } }
    ]
  ])
})

it.each(['local', 'runtime:server-1'] as const)(
  'negotiates alias-only ordinary adoption with %s while preserving old routes',
  (host) => {
    mocks.owner.mockReturnValue(host)
    const target = '/srv/orca'
    const resolve = (agent: AiVaultSession['agent'], cwd: string) =>
      resolveAiVaultSessionResumeInChatForWorkspace({
        session: { ...codexSession, agent, executionHostId: host, cwd, cwdAliases: [target] },
        resumeState: { blocked: false, worktreeId: PAIRED_WORKSPACE, usesSessionWorktree: true },
        activeWorkspaceId: PAIRED_WORKSPACE,
        targetState: {
          folderWorkspaces: [],
          projectGroups: [],
          repos: [],
          worktreesByRepo: {
            'repo-1': [makeWorktree(PAIRED_WORKSPACE, 'workspace', { path: target })]
          }
        },
        settings: { agentDefaultSurface: 'chat' }
      })
    const old = [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY]
    const set = (capabilities: readonly string[]) => {
      mocks.localCapabilities.mockReturnValue(capabilities)
      mocks.state.runtimeStatusByEnvironmentId.set('server-1', { status: { capabilities } })
    }
    set(old)
    expect(resolve('claude', '/physical/orca')).toMatchObject({ available: false })
    expect(resolve('claude', target)).toMatchObject({ available: true })
    expect(resolve('pi', '/physical/orca')).toMatchObject({ available: true })
    expect(resolve('codex', '/elsewhere')).toMatchObject({ available: true })
    set([...old, STRUCTURED_AGENT_SESSION_RESUME_LINKED_CWD_RUNTIME_CAPABILITY])
    expect(resolve('claude', '/physical/orca')).toMatchObject({ available: true })
  }
)

describe('resuming a conversation from history in a chat', () => {
  // A paired server cannot read a client-local transcript, matching terminal resume restrictions.
  it("is not offered in a paired server's workspace for a conversation recorded here", () => {
    mocks.owner.mockReturnValue('runtime:server-1')

    expect(resumeInChat()).toEqual({ available: false, reason: 'workspace' })
  })

  it('is offered in a workspace on the machine that recorded it', () => {
    mocks.owner.mockReturnValue('local')

    expect(resumeInChat()).toEqual({ available: true, workspaceId: PAIRED_WORKSPACE })
  })

  it('asks the host that would run it whether it can resume, not another', () => {
    mocks.owner.mockReturnValue('local')
    mocks.localCapabilities.mockReturnValue([])

    expect(resumeInChat()).toEqual({ available: false, reason: 'workspace' })
  })
})

describe('paired runtime conversation ownership', () => {
  const remoteSession = { ...codexSession, executionHostId: 'runtime:server-1' as const }

  beforeEach(() => {
    mocks.owner.mockReturnValue('runtime:server-1')
  })

  it('offers a conversation on its recording runtime', () => {
    expect(resumeInChat(remoteSession)).toEqual({
      available: true,
      workspaceId: PAIRED_WORKSPACE
    })
  })

  it.each(['local', 'runtime:server-2', null])(
    'refuses moving the remote conversation to %s',
    (owner) => {
      mocks.owner.mockReturnValue(owner)
      expect(resumeInChat(remoteSession)).toEqual({ available: false, reason: 'workspace' })
    }
  )

  it('requires the recording runtime to advertise history adoption', () => {
    mocks.state.runtimeStatusByEnvironmentId = new Map([
      ['server-1', { status: { capabilities: [] } }]
    ])
    expect(resumeInChat(remoteSession)).toEqual({ available: false, reason: 'workspace' })
  })

  it('refuses when runtime capabilities are not known yet', () => {
    mocks.state.runtimeStatusByEnvironmentId = new Map()
    expect(resumeInChat(remoteSession)).toEqual({ available: false, reason: 'workspace' })
  })
})
