import { describe, expect, it } from 'vitest'
import { AgentLaunchReplay } from '../../../src/shared/rpc-contract/agent-launch/agent-launch-params'
import { agentLaunchExistingParams } from '../../../mobile/src/session/agent-launch/agent-launch-request'
import {
  reserveMobileAgentLaunch,
  reservedAgentLaunchFields
} from '../../../mobile/src/session/agent-launch/mobile-agent-launch-reservation'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  releaseModuleExport,
  resolveBaselineReleaseRef
} from './release-checkout'

// A phone reserves its new chat's id on agent.launchReplay; a shipped host must still admit it.
const SUITE_TIMEOUT_MS = 180_000
const LAUNCH_PARAMS = 'src/shared/rpc-contract/agent-launch/agent-launch-params.ts'
// A shipped host's launch capabilities, without the plain-session-id one.
const SHIPPED_HOST_CAPABILITIES = ['agent.launch.v2', 'agent.launch.replay-required.v1']
const OPERATION_ID = '1767225600000-00000000000040008000000000000002'

type Schema = { safeParse: (value: unknown) => { success: boolean } }

function fixedUuids(): () => string {
  const uuids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'
  ]
  return () => uuids.shift()!
}

describe('a reserved chat id on agent.launchReplay, across versions', () => {
  it(
    'new phone against the shipped host: the host admits the phone’s reservation',
    async () => {
      const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
      const shipped = releaseModuleExport<Schema>(
        await importReleaseCheckoutModule(checkout, LAUNCH_PARAMS),
        'AgentLaunchReplay'
      )
      const reservation = reserveMobileAgentLaunch(
        'claude',
        SHIPPED_HOST_CAPABILITIES,
        fixedUuids()
      )
      const params = agentLaunchExistingParams({
        agent: 'claude',
        worktreeId: 'workspace-1',
        operationId: OPERATION_ID,
        ...reservedAgentLaunchFields(reservation)
      })
      expect(params).toHaveProperty('sessionId')
      expect(shipped.safeParse(params).success).toBe(true)
    },
    SUITE_TIMEOUT_MS
  )

  it('the current host admits a plain reserved id', () => {
    const params = {
      agent: 'claude',
      operationId: OPERATION_ID,
      target: { kind: 'existing', worktree: 'id:workspace-1' },
      paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      sessionId: '3540ecf3-47c3-4876-b825-81bf5d6b3595'
    }
    expect(AgentLaunchReplay.safeParse(params).success).toBe(true)
  })
})
