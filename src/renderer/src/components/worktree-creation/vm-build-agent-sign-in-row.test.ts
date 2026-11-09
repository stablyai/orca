import { describe, expect, it } from 'vitest'
import type { HostAgentSignInReport } from '../../../../shared/host-agent-sign-in-status'
import { deriveVmBuildAgentSignInRow } from './VmBuildAgentSignInRow'

const report = (claude: string, codex: string): HostAgentSignInReport =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: states are the literal union.
  ({
    checkedAt: 0,
    agents: [
      { agent: 'claude', state: claude },
      { agent: 'codex', state: codex }
    ]
  }) as HostAgentSignInReport

const run = (patch = {}) => ({
  environmentId: 'env-vm',
  gateKey: 'sheet',
  running: false,
  current: null,
  next: [],
  signedIn: [],
  ...patch
})

describe('VM build sheet sign-in row', () => {
  it('stays hidden when nothing on the VM needs signing in', () => {
    expect(deriveVmBuildAgentSignInRow(null, null, null)).toBeNull()
    expect(deriveVmBuildAgentSignInRow(report('signedIn', 'notInstalled'), null, null)).toBeNull()
  })

  it('offers only the signed-out agents', () => {
    expect(deriveVmBuildAgentSignInRow(report('signedIn', 'signedOut'), null, null)).toEqual({
      kind: 'idle',
      agents: ['codex']
    })
  })

  it('shows the sheet’s sign-ins as done before the VM’s re-check lands', () => {
    const signedIn = [
      { agent: 'claude' as const, email: 'me@example.com' },
      { agent: 'codex' as const, email: 'me@example.com' }
    ]
    expect(
      deriveVmBuildAgentSignInRow(report('signedOut', 'signedOut'), run({ signedIn }), null)
    ).toEqual({ kind: 'done', agents: signedIn })
  })
})
