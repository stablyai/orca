import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

const mocks = vi.hoisted(() => ({
  owner: vi.fn<() => string | null>(() => 'local'),
  localCapabilities: vi.fn<() => readonly string[] | null>(() => []),
  callRuntimeRpc: vi.fn(),
  state: { runtimeStatusByEnvironmentId: new Map<string, unknown>() }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  resolveStructuredAgentSessionOwner: mocks.owner
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.localCapabilities
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
// The route's own feasibility is pinned elsewhere; this suite pins the host rule on top of it.
vi.mock('@/lib/agent-session-launch-plan', () => ({
  structuredAgentSessionLaunchFeasible: () => true
}))

import { resolveAiVaultSessionResumeInChatForWorkspace } from './ai-vault-session-resume-in-chat-workspace'
import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'

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

function resumeInChat() {
  return resolveAiVaultSessionResumeInChatForWorkspace({
    session: codexSession,
    resumeState: { blocked: true, worktreeId: null, usesSessionWorktree: false },
    activeWorkspaceId: PAIRED_WORKSPACE,
    targetState: { folderWorkspaces: [], projectGroups: [], repos: [], worktreesByRepo: {} },
    settings: {
      experimentalNativeChat: true
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

afterEach(() => resetHostStructuredAgentsForTests())

async function recordingHostLists(capabilities: Record<string, unknown>): Promise<void> {
  mocks.callRuntimeRpc.mockResolvedValue({ agents: [{ agent: 'codex', capabilities }] })
  await loadHostStructuredAgents(
    'local',
    [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
    null
  )
}

describe('resuming a conversation from history in a chat', () => {
  // The conversation's transcript is on this machine, which the server cannot read; the
  // terminal resume refuses that target for the same reason.
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

  it("follows the recording host's adoption flag once that host has listed its agents", async () => {
    mocks.owner.mockReturnValue('local')
    await recordingHostLists({ transcriptAdoption: false })

    expect(resumeInChat()).toEqual({ available: false, reason: 'agent' })
  })

  it('keeps offering it from a host whose list predates the adoption flag', async () => {
    mocks.owner.mockReturnValue('local')
    await recordingHostLists({})

    expect(resumeInChat()).toEqual({ available: true, workspaceId: PAIRED_WORKSPACE })
  })
})
