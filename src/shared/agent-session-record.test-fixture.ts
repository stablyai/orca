/** Durable-record fixtures shared by the write-admission tests across shared, runtime, and IPC. */

import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionLease,
  type AgentSessionRecord
} from './agent-session-record'

const OWNER_PROCESS = {
  hostId: 'local',
  pid: 4242,
  processStartTimeMs: 1_700_000_000_000,
  spawnToken: 'spawn-tui'
}

/** A proven-live TUI owner: the only lease state that admits a PTY write. */
export function agentSessionLeaseFixture(
  overrides: Partial<AgentSessionLease> = {}
): AgentSessionLease {
  return {
    sessionId: 'session-alpha-1',
    runtimeKind: 'tui',
    runtimeFence: 7,
    handoffStage: null,
    provenHandleLinkId: 'link-1',
    ownerProcess: OWNER_PROCESS,
    reservedSpawnToken: 'spawn-tui',
    leaseDeadlineAt: 60_000,
    lastRenewedAt: 30_000,
    handoffOperationId: null,
    journalCheckpoint: null,
    claimKeyId: 'key-1',
    claimStatus: 'live',
    unreconciled: false,
    deathEvidence: null,
    ...overrides
  }
}

export function agentSessionRecordFixture(
  lease: AgentSessionLease = agentSessionLeaseFixture()
): AgentSessionRecord {
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: lease.sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    providerHandleChain: [
      {
        linkId: 'link-1',
        origin: 'created',
        mintedAtFence: lease.runtimeFence,
        observedAt: 1_000,
        handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: null }
      }
    ],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/user/.claude' },
    lease,
    createdAt: 1_000,
    updatedAt: 2_000
  }
}
