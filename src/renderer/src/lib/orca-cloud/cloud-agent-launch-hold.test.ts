// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  cloudAgentHoldReason,
  cloudAgentLaunchHoldReason,
  cloudAgentLaunchNeedsHold,
  cloudAgentStripReason,
  holdCloudAgentLaunch,
  readCloudAgentHold,
  releaseCloudAgentHold
} from './cloud-agent-launch-hold'
import {
  setOrcaCloudAgentAccountsStateForTest,
  type OrcaCloudAgentAccountsState
} from './orca-cloud-agent-accounts-store'

function accounts(
  claude: OrcaCloudAgentsStatus['credentials']['claude'],
  extra: Partial<OrcaCloudAgentsStatus['credentials']> = {},
  covered = false
): OrcaCloudAgentAccountsState {
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
        sources: { defaults: {}, coveredByKey: { claude: covered, codex: false } }
      }
    },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: covered ? 'team' : null, codex: null },
    queue: { agents: [], index: 0 }
  }
}

describe('cloud agent launch hold', () => {
  it('maps the Orca account to the strip reason, never from the sandbox', () => {
    expect(cloudAgentStripReason('claude', accounts({ state: 'active' }))).toBeNull()
    expect(cloudAgentStripReason('claude', accounts({ state: 'expired' }))).toBe('accountExpired')
    expect(cloudAgentStripReason('claude', accounts({ state: 'revoked' }))).toBe('accountExpired')
    // A key covers it: no strip, requests fall back to the key.
    expect(cloudAgentStripReason('claude', accounts({ state: 'expired' }, {}, true))).toBeNull()
    expect(
      cloudAgentStripReason(
        'claude',
        accounts(
          { state: 'active' },
          {
            providerEnabled: { claude: false, codex: true },
            providerState: { claude: 'disabled', codex: 'on' }
          }
        )
      )
    ).toBe('paused')
    expect(
      cloudAgentStripReason(
        'claude',
        accounts(
          { state: 'none' },
          {
            providerEnabled: { claude: false, codex: true },
            providerState: { claude: 'off', codex: 'on' }
          }
        )
      )
    ).toBe('notOffered')
  })

  it('never holds a ready launch, and decides from the cached read', () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    expect(cloudAgentLaunchNeedsHold('claude')).toBe(false)
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    expect(cloudAgentLaunchNeedsHold('claude')).toBe(true)
  })

  it('holds an expired launch until Renew fixes the account, then every held pane goes', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const first = holdCloudAgentLaunch({ paneKey: 'tab:a', agent: 'claude', prompt: 'fix it' })
    const second = holdCloudAgentLaunch({ paneKey: 'tab:b', agent: 'claude', prompt: null })
    await vi.waitFor(() => expect(readCloudAgentHold('tab:b')).not.toBeNull())
    expect(readCloudAgentHold('tab:a')).toMatchObject({ prompt: 'fix it' })
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await expect(first).resolves.toBe('proceed')
    await expect(second).resolves.toBe('proceed')
    expect(readCloudAgentHold('tab:a')).toBeNull()
  })

  it('cancel releases only that pane', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const held = holdCloudAgentLaunch({ paneKey: 'tab:c', agent: 'claude', prompt: null })
    await vi.waitFor(() => expect(readCloudAgentHold('tab:c')).not.toBeNull())
    releaseCloudAgentHold('tab:c', 'cancel')
    await expect(held).resolves.toBe('cancel')
  })

  it('holds a launch whose agent is not set up (PC-3b), and waits for Start, never starting unasked', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    expect(cloudAgentHoldReason('claude', accounts({ state: 'none' }))).toBe('notSetUp')
    expect(cloudAgentLaunchHoldReason('claude')).toBe('notSetUp')
    expect(cloudAgentLaunchNeedsHold('claude')).toBe(true)
    const held = holdCloudAgentLaunch({ paneKey: 'tab:d', agent: 'claude', prompt: 'go' })
    await vi.waitFor(() =>
      expect(readCloudAgentHold('tab:d')).toMatchObject({ reason: 'notSetUp' })
    )
    // Set up finishes: the strip offers Start; the launch still waits for it.
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    // Let any subscriber run (zero-delay yields); the hold must still be waiting for Start.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(readCloudAgentHold('tab:d')).not.toBeNull()
    releaseCloudAgentHold('tab:d', 'proceed')
    await expect(held).resolves.toBe('proceed')
  })

  it('a key covering the agent never holds it as not set up', () => {
    expect(cloudAgentHoldReason('claude', accounts({ state: 'none' }, {}, true))).toBeNull()
  })

  it('tells the composer the hold is unknown while the account read is loading', () => {
    setOrcaCloudAgentAccountsStateForTest({
      ...accounts({ state: 'none' }),
      load: { kind: 'loading' }
    })
    expect(cloudAgentLaunchHoldReason('claude')).toBe('unknown')
  })

  it('a decided hold whose account is already covered starts at once', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await expect(
      holdCloudAgentLaunch({ paneKey: 'tab:e', agent: 'claude', prompt: null, decided: true })
    ).resolves.toBe('proceed')
    expect(readCloudAgentHold('tab:e')).toBeNull()
  })
})
