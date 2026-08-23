/** Anonymized derivatives of schema-1 rows observed across ad-hoc structured-session builds. */

export const LEGACY_AGENT_SESSION_ID = 'desktop_mstny52oa2243469'
export const LEGACY_CODEX_THREAD_ID = '01a002e9-9a1c-7d42-a642-e481f64446f1'

export function legacyAgentSessionRecordV1(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId: LEGACY_AGENT_SESSION_ID,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'repo-fixture::/isolated/legacy-worktree',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    providerHandleChain: [
      {
        linkId: `codex-1-${LEGACY_CODEX_THREAD_ID}`,
        handle: { provider: 'codex', threadId: LEGACY_CODEX_THREAD_ID },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1_800_000_000_000
      }
    ],
    accountHome: { variable: 'CODEX_HOME', path: '/isolated/codex-home' },
    lease: {
      sessionId: LEGACY_AGENT_SESSION_ID,
      runtimeKind: 'native',
      runtimeFence: 2,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 1_800_000_030_000,
      lastRenewedAt: 1_800_000_000_000,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'legacy-key-1',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000
  }
}

export function legacyDesktopProviderHandleRecordV1(): Record<string, unknown> {
  const record = legacyAgentSessionRecordV1()
  const link = (record.providerHandleChain as Record<string, unknown>[])[0]!
  return {
    ...record,
    providerHandleChain: [
      {
        ...link,
        linkId: `codex-1-${LEGACY_AGENT_SESSION_ID}`,
        handle: { provider: 'codex', threadId: LEGACY_AGENT_SESSION_ID }
      }
    ]
  }
}

export function legacyMissingAuthorityRecordV1(): Record<string, unknown> {
  const record = legacyAgentSessionRecordV1()
  const lease = { ...(record.lease as Record<string, unknown>) }
  for (const field of [
    'claimStatus',
    'ownerProcess',
    'reservedSpawnToken',
    'handoffStage',
    'journalCheckpoint',
    'deathEvidence'
  ]) {
    delete lease[field]
  }
  const { accountHome: _accountHome, ...withoutAccountHome } = record
  return { ...withoutAccountHome, lease }
}
