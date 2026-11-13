// @vitest-environment happy-dom
// HELD-STALE-COVERED: a held launch re-decides on every account change, and Start never trusts the
// cached read. Real repro (m4air, #568 proof P3b): set up -> "Start Claude" -> the sign-in is revoked
// -> the strip still said "Start Claude", and Start launched Claude onto the revoked account.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  holdCloudAgentLaunch,
  readCloudAgentHold,
  releaseCloudAgentHold,
  startCloudAgentHold
} from './cloud-agent-launch-hold'
import {
  setOrcaCloudAgentAccountsStateForTest,
  type OrcaCloudAgentAccountsState
} from './orca-cloud-agent-accounts-store'

type Claude = OrcaCloudAgentsStatus['credentials']['claude']

function status(claude: Claude): OrcaCloudAgentsStatus {
  return {
    credentials: {
      claude,
      codex: { state: 'none' },
      providerEnabled: { claude: true, codex: true }
    },
    sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
  }
}

function accounts(claude: Claude): OrcaCloudAgentAccountsState {
  return {
    load: { kind: 'ready', status: status(claude) },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  }
}

const main = vi.hoisted(() => {
  const value: { answer: { ok: true; value: unknown } | { ok: false; error: 'unknown' } } = {
    answer: { ok: false, error: 'unknown' }
  }
  return value
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { orcaCloudAgents: { status: async () => main.answer } }
  })
})
afterEach(() => {
  for (const key of ['tab:s1', 'tab:s2', 'tab:s3', 'tab:s4', 'tab:s5', 'tab:s6']) {
    releaseCloudAgentHold(key, 'cancel')
  }
})

async function setUpHold(paneKey: string): Promise<{ outcome: () => string }> {
  setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
  let outcome = 'pending'
  void holdCloudAgentLaunch({ paneKey, agent: 'claude', prompt: null }).then((o) => {
    outcome = o
  })
  await vi.waitFor(() => expect(readCloudAgentHold(paneKey)).toMatchObject({ reason: 'notSetUp' }))
  return { outcome: () => outcome }
}

describe('HELD-STALE-COVERED', () => {
  it('setup finished here: "is set up · Start" (muted, not the amber key), and it waits for Start', async () => {
    const hold = await setUpHold('tab:s1')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await settle()
    expect(readCloudAgentHold('tab:s1')).toMatchObject({
      reason: 'awaitingStart',
      awaiting: 'setUp'
    })
    expect(hold.outcome()).toBe('pending')
  })

  it('covered -> revoked: the hold goes back to Renew (accountExpired), and Start does not launch', async () => {
    const hold = await setUpHold('tab:s2')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await settle()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    await settle()
    expect(readCloudAgentHold('tab:s2')).toMatchObject({ reason: 'accountExpired' })
    main.answer = { ok: true, value: status({ state: 'revoked' }) }
    await expect(startCloudAgentHold('tab:s2')).resolves.toBe('held')
    await settle()
    expect(readCloudAgentHold('tab:s2')).toMatchObject({ reason: 'accountExpired' })
    expect(hold.outcome()).toBe('pending')
  })

  it('Start with a stale "active" cache and a fresh read showing revoked: no launch, Renew shown', async () => {
    const hold = await setUpHold('tab:s3')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await settle()
    expect(readCloudAgentHold('tab:s3')).toMatchObject({ awaiting: 'setUp' })
    main.answer = { ok: true, value: status({ state: 'revoked' }) }
    await expect(startCloudAgentHold('tab:s3')).resolves.toBe('held')
    await settle()
    expect(readCloudAgentHold('tab:s3')).toMatchObject({ reason: 'accountExpired' })
    expect(hold.outcome()).toBe('pending')
  })

  it('Start with a fresh read that still covers the agent launches it', async () => {
    const hold = await setUpHold('tab:s4')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await settle()
    main.answer = { ok: true, value: status({ state: 'active' }) }
    await expect(startCloudAgentHold('tab:s4')).resolves.toBe('started')
    await settle()
    expect(hold.outcome()).toBe('proceed')
    expect(readCloudAgentHold('tab:s4')).toBeNull()
  })

  it('a removed sign-in goes back to "Set up once"; a failed fresh read keeps it held', async () => {
    const hold = await setUpHold('tab:s5')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await settle()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    await settle()
    expect(readCloudAgentHold('tab:s5')).toMatchObject({ reason: 'notSetUp' })
    main.answer = { ok: false, error: 'unknown' }
    await expect(startCloudAgentHold('tab:s5')).resolves.toBe('held')
    expect(readCloudAgentHold('tab:s5')).not.toBeNull()
    expect(hold.outcome()).toBe('pending')
  })

  it('in-session expired -> sign-in removed -> set up again: waits for Start, never auto-starts (PC-3b)', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    let outcome = 'pending'
    void holdCloudAgentLaunch({ paneKey: 'tab:s6', agent: 'claude', prompt: null }).then((o) => {
      outcome = o
    })
    await vi.waitFor(() =>
      expect(readCloudAgentHold('tab:s6')).toMatchObject({ reason: 'accountExpired' })
    )
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    await settle()
    expect(readCloudAgentHold('tab:s6')).toMatchObject({ reason: 'notSetUp' })
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await settle()
    expect(readCloudAgentHold('tab:s6')).toMatchObject({
      reason: 'awaitingStart',
      awaiting: 'setUp'
    })
    expect(outcome).toBe('pending')
  })
})
