import { beforeEach, describe, expect, it } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { OrcaCloudAgentAccountsState } from './orca-cloud-agent-accounts-store'
import {
  CLOUD_RUNNING_LIVE_READ_MS,
  cloudRunningLiveReadDue,
  clearCloudRunningSignout,
  cloudRunningStrip,
  resetCloudRunningSignoutForTest,
  workspaceUsesAccount
} from './cloud-running-agent-signout'

function accounts(
  claude: OrcaCloudAgentsStatus['credentials']['claude'],
  extra: Partial<OrcaCloudAgentsStatus['credentials']> = {}
): Pick<OrcaCloudAgentAccountsState, 'load' | 'keyKinds'> {
  return {
    load: {
      kind: 'ready',
      status: {
        credentials: {
          claude,
          codex: { state: 'none' },
          providerEnabled: { claude: true, codex: true },
          ...extra
        },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    keyKinds: { claude: null, codex: null }
  }
}

const RUNNING = { agentType: 'claude', state: 'working' as const, providerSession: { id: 's1' } }
const strip = (
  account: ReturnType<typeof accounts>,
  entry: Parameters<typeof cloudRunningStrip>[0]['entry'] = RUNNING,
  now = 1_000,
  paneKey = 'tab:a',
  usesAccount: boolean | null = true
) =>
  cloudRunningStrip({
    paneKey,
    entry,
    accounts: account,
    held: false,
    now,
    usesAccount,
    revision: 0
  })

describe('cloudRunningStrip (RA-11)', () => {
  beforeEach(resetCloudRunningSignoutForTest)

  it('shows nothing while the account works, and state 1 once it expires or is revoked', () => {
    expect(strip(accounts({ state: 'active' }))).toBeNull()
    expect(strip(accounts({ state: 'revoked' }))).toEqual({ phase: 'expired', agent: 'claude' })
    expect(strip(accounts({ state: 'expired' }), RUNNING, 1_000, 'tab:b')).toEqual({
      phase: 'expired',
      agent: 'claude'
    })
  })

  it('after Renew the panes that showed state 1 move to state 2, resumable when the pane has a session', () => {
    strip(accounts({ state: 'revoked' }))
    expect(strip(accounts({ state: 'active' }))).toEqual({
      phase: 'renewed',
      agent: 'claude',
      resumable: true
    })
    // A pane that never showed state 1 gets nothing.
    expect(strip(accounts({ state: 'active' }), RUNNING, 1_000, 'tab:other')).toBeNull()
    strip(
      accounts({ state: 'revoked' }),
      { ...RUNNING, providerSession: undefined },
      1_000,
      'tab:c'
    )
    expect(
      strip(
        accounts({ state: 'active' }),
        { ...RUNNING, providerSession: undefined },
        1_000,
        'tab:c'
      )
    ).toMatchObject({ phase: 'renewed', resumable: false })
  })

  it('never auto-restarts: state 2 stays until Restart or dismiss; a clean turn after renewal clears it', () => {
    strip(accounts({ state: 'revoked' }))
    expect(strip(accounts({ state: 'active' }), RUNNING, 2_000)?.phase).toBe('renewed')
    expect(strip(accounts({ state: 'active' }), RUNNING, 9_000)?.phase).toBe('renewed')
    // The agent's next call succeeded through egress: its turn ended cleanly after the renewal.
    const recovered = { ...RUNNING, state: 'done' as const, turnEndedAt: 3_000 }
    expect(strip(accounts({ state: 'active' }), recovered, 9_000)).toBeNull()
    strip(accounts({ state: 'revoked' }), RUNNING, 1_000, 'tab:d')
    strip(accounts({ state: 'active' }), RUNNING, 2_000, 'tab:d')
    clearCloudRunningSignout('tab:d')
    expect(strip(accounts({ state: 'active' }), RUNNING, 3_000, 'tab:d')).toBeNull()
  })

  it('a structured chat (no turnEndedAt) clears after a clean turn by its done-since time; a pane does not', () => {
    const chat = (entry: Parameters<typeof cloudRunningStrip>[0]['entry'], paneKey: string) =>
      cloudRunningStrip({
        paneKey,
        entry,
        accounts: accounts({ state: 'active' }),
        held: false,
        now: 2_000,
        usesAccount: true,
        revision: 0,
        turnEndedFallback: true
      })
    strip(accounts({ state: 'revoked' }), RUNNING, 1_000, 'chat:a')
    expect(chat(RUNNING, 'chat:a')?.phase).toBe('renewed')
    // Done since before the renewal: that turn is the one that failed, not a recovery.
    expect(chat({ ...RUNNING, state: 'done', stateStartedAt: 1_500 }, 'chat:a')?.phase).toBe(
      'renewed'
    )
    expect(chat({ ...RUNNING, state: 'done', stateStartedAt: 3_000 }, 'chat:a')).toBeNull()
    // A terminal pane keeps needing turnEndedAt.
    strip(accounts({ state: 'revoked' }), RUNNING, 1_000, 'tab:e')
    expect(strip(accounts({ state: 'active' }), RUNNING, 2_000, 'tab:e')?.phase).toBe('renewed')
    expect(
      strip(
        accounts({ state: 'active' }),
        { ...RUNNING, state: 'done', stateStartedAt: 3_000 },
        2_000,
        'tab:e'
      )?.phase
    ).toBe('renewed')
  })

  it('shows nothing new under the kill switch, for a held launch, or without a running account agent', () => {
    expect(
      strip(
        accounts(
          { state: 'revoked' },
          {
            providerEnabled: { claude: false, codex: true },
            providerState: { claude: 'disabled', codex: 'on' }
          }
        )
      )
    ).toBeNull()
    expect(
      cloudRunningStrip({
        paneKey: 'tab:e',
        entry: RUNNING,
        accounts: accounts({ state: 'revoked' }),
        held: true,
        now: 1,
        usesAccount: true,
        revision: 0
      })
    ).toBeNull()
    expect(strip(accounts({ state: 'revoked' }), { ...RUNNING, agentType: 'gemini' })).toBeNull()
    expect(strip(accounts({ state: 'revoked' }), null)).toBeNull()
  })
})

describe('D13: only workspaces that run the agent on the person’s own account', () => {
  beforeEach(resetCloudRunningSignoutForTest)
  const view = (extra: Record<string, unknown> = {}) => ({
    defaults: {},
    coveredByKey: { claude: false, codex: false },
    ...extra
  })

  it('reads the workspace Source: shared and key-sourced workspaces never use the account', () => {
    expect(workspaceUsesAccount(view({ sharedWorkspace: true }), 'claude')).toBe(false)
    expect(workspaceUsesAccount(view({ effective: { claude: { source: 'key' } } }), 'claude')).toBe(
      false
    )
    expect(workspaceUsesAccount(view({ defaults: { claude: 'key' } }), 'claude')).toBe(false)
    // Nothing chosen and a key covers the agent: the key wins.
    expect(
      workspaceUsesAccount(view({ coveredByKey: { claude: true, codex: false } }), 'claude')
    ).toBe(false)
    expect(
      workspaceUsesAccount(view({ effective: { claude: { source: 'sign-in' } } }), 'claude')
    ).toBe(true)
    expect(workspaceUsesAccount(view(), 'claude')).toBe(true)
  })

  it('shows no strip for a shared or keyed workspace, nor while the Source is unread (fail quiet)', () => {
    expect(strip(accounts({ state: 'revoked' }), RUNNING, 1_000, 'tab:s', false)).toBeNull()
    expect(strip(accounts({ state: 'revoked' }), RUNNING, 1_000, 'tab:u', null)).toBeNull()
    expect(strip(accounts({ state: 'revoked' }), RUNNING, 1_000, 'tab:y', true)?.phase).toBe(
      'expired'
    )
  })
})

describe('running-pane live read (RA-11f)', () => {
  it('re-reads about every 30 s, so a revoke reaches the strip within ~30 s', () => {
    expect(CLOUD_RUNNING_LIVE_READ_MS).toBe(30_000)
    // A read from any caller within the last ~29 s counts; the poll skips.
    expect(cloudRunningLiveReadDue(100_000, 110_000)).toBe(false)
    expect(cloudRunningLiveReadDue(100_000, 128_999)).toBe(false)
    // A poll old: the poll forces a fresh read (no 30 s cache skip at the boundary).
    expect(cloudRunningLiveReadDue(100_000, 129_000)).toBe(true)
    expect(cloudRunningLiveReadDue(100_000, 160_000)).toBe(true)
  })
})
