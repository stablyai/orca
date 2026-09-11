/**
 * Who would adopt an Agent Session History row, and whether that host ever said it could.
 *
 * The E-history scenarios: same-owner remote resume is offered, a source/target mismatch is refused
 * rather than re-homed, a host that predates `resumeFrom` makes the action absent instead of a blind
 * create, and a host that has merely not answered is never read as one that said no.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { AgentLaunchRouteStore } from '@/lib/agent-launch-route-input'
import type { RuntimeEnvironmentStatus } from '@/store/slices/runtime-status-types'

const mocks = vi.hoisted(() => ({
  getExecutionHostIdForWorktree: vi.fn(),
  readLocalRuntimeCapabilitiesOrUnknown: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: mocks.getExecutionHostIdForWorktree
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.readLocalRuntimeCapabilitiesOrUnknown
}))

import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { structuredAgentSessionOwnerMatchesPairing } from '@/runtime/structured-agent-session-owner'
import { resolveAiVaultSessionResumeInChatOwner } from './ai-vault-session-resume-in-chat-owner'

const NOW = 1_700_000_000_000
const ENVIRONMENT_ID = 'env-1'
const REMOTE_HOST_ID = 'runtime:env-1'
const WORKSPACE_ID = 'repo-1::/repo/orca'

const WITH_RESUME_HISTORY = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
]
const WITHOUT_RESUME_HISTORY = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AI_VAULT_RUNTIME_CAPABILITY
]

function hostStatus(capabilities: readonly string[]): RuntimeStatus {
  return { runtimeId: 'rt-1', capabilities: [...capabilities] } as unknown as RuntimeStatus
}

function entry(patch: Partial<RuntimeHostStatusSnapshot> = {}): RuntimeEnvironmentStatus {
  const snapshot: RuntimeHostStatusSnapshot = {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: 7,
    sequence: 1,
    checkedAt: NOW,
    transport: 'ready',
    verification: 'verified',
    status: hostStatus(WITH_RESUME_HISTORY),
    ...patch
  }
  return { snapshot, status: snapshot.status, checkedAt: snapshot.checkedAt }
}

function store(host?: RuntimeEnvironmentStatus): AgentLaunchRouteStore {
  return {
    settings: {},
    runtimeStatusByEnvironmentId: host
      ? new Map([[ENVIRONMENT_ID, host]])
      : new Map<string, RuntimeEnvironmentStatus>()
  } as unknown as AgentLaunchRouteStore
}

function verdict(args: {
  host?: RuntimeEnvironmentStatus
  sessionExecutionHostId?: string
  sessionFilePath?: string | null
  targetWorkspaceId?: string | null
}) {
  return resolveAiVaultSessionResumeInChatOwner({
    store: store(args.host),
    sessionExecutionHostId: args.sessionExecutionHostId ?? REMOTE_HOST_ID,
    sessionFilePath: args.sessionFilePath ?? '/home/dev/.codex/sessions/rollout.jsonl',
    targetWorkspaceId: args.targetWorkspaceId === undefined ? WORKSPACE_ID : args.targetWorkspaceId
  })
}

describe('resolveAiVaultSessionResumeInChatOwner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: 7 }])
    mocks.getExecutionHostIdForWorktree.mockReturnValue(REMOTE_HOST_ID)
    mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue(WITH_RESUME_HISTORY)
  })

  afterEach(() => {
    vi.useRealTimers()
    replaceRuntimeEnvironmentRevisions([])
  })

  it('adopts a paired row into a workspace on that same host, pinned to its pairing', () => {
    expect(verdict({ host: entry() })).toEqual({
      adoptable: true,
      executionHostId: REMOTE_HOST_ID,
      owner: { kind: 'environment', environmentId: ENVIRONMENT_ID, pairingRevision: 7 }
    })
  })

  it('stops matching the pin once that host is re-paired, rather than re-resolving it', () => {
    const answer = verdict({ host: entry() })
    expect(answer.adoptable).toBe(true)
    if (!answer.adoptable) {
      return
    }
    expect(structuredAgentSessionOwnerMatchesPairing(answer.owner)).toBe(true)
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: 8 }])
    expect(structuredAgentSessionOwnerMatchesPairing(answer.owner)).toBe(false)
  })

  it('refuses a row this machine recorded against a workspace the paired host owns', () => {
    expect(verdict({ host: entry(), sessionExecutionHostId: 'local' })).toEqual({
      adoptable: false,
      executionHostId: REMOTE_HOST_ID,
      reason: 'owner-mismatch'
    })
  })

  it('refuses a paired row against a workspace on this machine', () => {
    mocks.getExecutionHostIdForWorktree.mockReturnValue('local')
    expect(verdict({})).toEqual({
      adoptable: false,
      executionHostId: 'local',
      reason: 'owner-mismatch'
    })
  })

  it('refuses a row on an older host that never advertised it can adopt a conversation', () => {
    // The old-host arm. Calling to find out is exactly what a strict union makes unreadable, so the
    // verdict has to come from what the host advertised.
    expect(verdict({ host: entry({ status: hostStatus(WITHOUT_RESUME_HISTORY) }) })).toEqual({
      adoptable: false,
      executionHostId: REMOTE_HOST_ID,
      reason: 'resume-history'
    })
  })

  it.each([
    ['has not answered yet', entry({ verification: 'unavailable', status: null })],
    ['this client disconnected', entry({ retired: true, transport: 'disconnected' })],
    ['has no published entry at all', undefined]
  ])('withholds the action from a host that %s', (_label, host) => {
    expect(verdict({ host })).toMatchObject({ adoptable: false, reason: 'resume-history' })
  })

  it('reads the owning host, never this client, for a paired row', () => {
    verdict({ host: entry({ status: hostStatus(WITHOUT_RESUME_HISTORY) }) })
    expect(mocks.readLocalRuntimeCapabilitiesOrUnknown).not.toHaveBeenCalled()
  })

  it('adopts a local row into a local workspace once this machine advertises it', () => {
    mocks.getExecutionHostIdForWorktree.mockReturnValue('local')
    expect(verdict({ sessionExecutionHostId: 'local' })).toEqual({
      adoptable: true,
      executionHostId: 'local',
      owner: { kind: 'local' }
    })
  })

  it('withholds a local row while this machine has not answered its own probe', () => {
    mocks.getExecutionHostIdForWorktree.mockReturnValue('local')
    mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue(null)
    expect(verdict({ sessionExecutionHostId: 'local' })).toMatchObject({
      adoptable: false,
      reason: 'resume-history'
    })
  })

  it('keeps an SSH row refused whatever the paired host advertises', () => {
    mocks.getExecutionHostIdForWorktree.mockReturnValue('ssh:build-box')
    expect(verdict({ host: entry(), sessionExecutionHostId: 'ssh:build-box' })).toEqual({
      adoptable: false,
      executionHostId: 'ssh:build-box',
      reason: 'remote'
    })
  })

  it('has no owner to compare when no workspace is open', () => {
    expect(verdict({ targetWorkspaceId: null })).toEqual({
      adoptable: false,
      executionHostId: null,
      reason: 'workspace'
    })
  })
})
