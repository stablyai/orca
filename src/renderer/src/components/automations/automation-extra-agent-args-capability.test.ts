import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { AutomationCreateInput } from '../../../../shared/automations-types'

const callRuntimeRpc = vi.fn()
const getRuntimeEnvironmentStatus = vi.fn()

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  getRuntimeEnvironmentStatus: (...args: unknown[]) => getRuntimeEnvironmentStatus(...args),
  hasRuntimeRpcErrorCode: () => false
}))

const RUNTIME = { kind: 'runtime', environmentId: 'env-1', pairingRevision: 4 } as const
const OWNER = { authority: RUNTIME, selector: { kind: 'self' } } as const
const LEGACY_HOST = {
  capabilities: [
    AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
    AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
  ]
}
const CURRENT_HOST = {
  capabilities: [...LEGACY_HOST.capabilities, AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY]
}
const INPUT: AutomationCreateInput = {
  creationKey: 'move-1',
  name: 'Docs pass',
  prompt: 'go',
  agentId: 'claude',
  projectId: 'repo-1',
  workspaceMode: 'new_per_run',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 1
}

async function client() {
  return await import('./automation-scoped-list-client')
}

beforeEach(async () => {
  callRuntimeRpc.mockReset()
  getRuntimeEnvironmentStatus.mockReset()
  ;(await client()).resetAutomationCapabilityProbes()
})

describe('extra agent args capability gate', () => {
  it('refuses a create or move to a host without the capability before writing', async () => {
    const { createAutomationForDestination } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(LEGACY_HOST)

    await expect(
      createAutomationForDestination(
        RUNTIME,
        { ...INPUT, extraAgentArgs: '--model opus' },
        { selector: { kind: 'self' } }
      )
    ).rejects.toThrow('Update Orca on this host to use extra arguments.')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('refuses an update that sets extras on an older host', async () => {
    const { updateAutomationForOwner } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(LEGACY_HOST)

    await expect(
      updateAutomationForOwner(OWNER, 'a1', { extraAgentArgs: '--model opus' })
    ).rejects.toThrow('Update Orca on this host to use extra arguments.')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('lets legacy-compatible writes through to older hosts', async () => {
    const { createAutomationForDestination, updateAutomationForOwner } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(LEGACY_HOST)
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })

    await createAutomationForDestination(RUNTIME, INPUT, { selector: { kind: 'self' } })
    await updateAutomationForOwner(OWNER, 'a1', { extraAgentArgs: '' })
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it('sends extras to a host that advertises the capability', async () => {
    const { createAutomationForDestination } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(CURRENT_HOST)
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })

    await createAutomationForDestination(
      RUNTIME,
      { ...INPUT, extraAgentArgs: '--model opus' },
      { selector: { kind: 'self' } }
    )
    expect(callRuntimeRpc.mock.calls[0]?.[2]).toMatchObject({ extraAgentArgs: '--model opus' })
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
  })

  it.each(['create', 'update'] as const)(
    'refuses %s after the same authority loses extras support',
    async (mutation) => {
      const { createAutomationForDestination, updateAutomationForOwner } = await client()
      getRuntimeEnvironmentStatus.mockResolvedValue(CURRENT_HOST)
      callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
      await createAutomationForDestination(
        RUNTIME,
        { ...INPUT, extraAgentArgs: '--model opus' },
        { selector: { kind: 'self' } }
      )
      callRuntimeRpc.mockClear()
      getRuntimeEnvironmentStatus.mockClear().mockResolvedValue(LEGACY_HOST)

      const write =
        mutation === 'create'
          ? createAutomationForDestination(
              RUNTIME,
              { ...INPUT, extraAgentArgs: '--model opus' },
              { selector: { kind: 'self' } }
            )
          : updateAutomationForOwner(OWNER, 'a1', { extraAgentArgs: '--model opus' })
      await expect(write).rejects.toThrow('Update Orca on this host to use extra arguments.')
      expect(callRuntimeRpc).not.toHaveBeenCalled()
      expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses a move after the same authority loses create idempotency', async () => {
    const { createAutomationForDestination } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(CURRENT_HOST)
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await createAutomationForDestination(RUNTIME, INPUT, { selector: { kind: 'self' } })
    callRuntimeRpc.mockClear()
    getRuntimeEnvironmentStatus.mockClear().mockResolvedValue({
      capabilities: [
        AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
        AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY
      ]
    })

    await expect(
      createAutomationForDestination(RUNTIME, INPUT, { selector: { kind: 'self' } })
    ).rejects.toThrow('Moving automations to this host requires a newer Orca server.')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
  })
})
