import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../../../shared/automation-owner-conflict'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'

const callRuntimeRpc = vi.fn()
const getRuntimeEnvironmentStatus = vi.fn()

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  getRuntimeEnvironmentStatus: (...args: unknown[]) => getRuntimeEnvironmentStatus(...args),
  // Why: the real matcher is exercised in runtime-rpc-result's own tests; here it only needs to be honest about the tail token.
  hasRuntimeRpcErrorCode: (error: unknown, code: string) =>
    typeof (error as { message?: unknown })?.message === 'string' &&
    (error as { message: string }).message.trimEnd().endsWith(`: ${code}`)
}))

const DESKTOP = { kind: 'desktop' } as const
const RUNTIME = { kind: 'runtime', environmentId: 'env-1', pairingRevision: 4 } as const
const SSH_OWNER = {
  authority: RUNTIME,
  selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 }
} as const

const ALL_CAPABILITIES = {
  capabilities: [
    AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
    AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY
  ]
}

beforeEach(async () => {
  callRuntimeRpc.mockReset()
  getRuntimeEnvironmentStatus.mockReset()
  // Confirmed capabilities are module-level and must not leak between tests.
  ;(await client()).resetAutomationCapabilityProbes()
})

async function client() {
  return await import('./automation-scoped-list-client')
}

describe('listScopedAutomations', () => {
  it('rejects a legacy-shaped payload instead of committing it as one host', async () => {
    const { listScopedAutomations, AutomationHostScopeUnsupportedError } = await client()
    callRuntimeRpc.mockResolvedValue({ automations: [{ id: 'a1' }] })
    await expect(listScopedAutomations(DESKTOP, { kind: 'self' })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })

  it('rejects a structurally broken payload', async () => {
    const { listScopedAutomations, AutomationListResponseError } = await client()
    callRuntimeRpc.mockResolvedValue({ automations: 'nope' })
    await expect(listScopedAutomations(DESKTOP, { kind: 'self' })).rejects.toBeInstanceOf(
      AutomationListResponseError
    )
  })

  it('drops rows the host scoped elsewhere and keeps the rest', async () => {
    const { listScopedAutomations } = await client()
    callRuntimeRpc.mockResolvedValue({
      automations: [{ id: 'a1' }, { id: 'a2' }],
      items: [
        { automationId: 'a1', selector: { kind: 'ssh', targetId: 'other', targetGeneration: 1 } },
        { automationId: 'a2', selector: { kind: 'self' } }
      ],
      orphanCount: 2
    })
    const result = await listScopedAutomations(DESKTOP, { kind: 'self' })
    expect(result.automations.map((entry) => entry.id)).toEqual(['a2'])
    expect(result.invalidRows).toBe(1)
    expect(result.orphanCount).toBe(2)
  })

  it('addresses the desktop authority as the local runtime target, unprobed', async () => {
    const { listScopedAutomations } = await client()
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
    await listScopedAutomations(DESKTOP, { kind: 'self' })
    expect(getRuntimeEnvironmentStatus).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'automation.list',
      { selector: { kind: 'self' } },
      // Why: the in-process runtime has no pairing revision to pin.
      expect.not.objectContaining({ expectedEnvironmentPairingRevision: expect.anything() })
    )
  })

  it('negotiates host scope and pins the request to the captured pairing revision', async () => {
    const { listScopedAutomations } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
    await listScopedAutomations(RUNTIME, {
      kind: 'ssh',
      targetId: 'ssh-1',
      expectedTargetGeneration: 7
    })
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledWith('env-1', expect.any(Number))
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.list',
      { selector: { kind: 'ssh', targetId: 'ssh-1', expectedTargetGeneration: 7 } },
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
  })

  it('surfaces a stale pairing revision instead of retrying unfenced', async () => {
    const { listScopedAutomations } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockRejectedValue(new Error('runtime_environment_revision_changed'))
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).rejects.toThrow(
      'runtime_environment_revision_changed'
    )
  })

  it('does not query a host that never advertised host scope', async () => {
    const { listScopedAutomations, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: [] })
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // An unreachable host proves nothing about its version, so it must not be reported as too old.
  it('propagates an unreachable authority instead of calling it incompatible', async () => {
    const { listScopedAutomations, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockRejectedValue(new Error('runtime_unavailable'))
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).rejects.not.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })
})

describe('capability probe dedupe', () => {
  it('shares one in-flight probe across concurrent calls to the same incarnation', async () => {
    const { listScopedAutomations } = await client()
    getRuntimeEnvironmentStatus.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return ALL_CAPABILITIES
    })
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
    await Promise.all([
      listScopedAutomations(RUNTIME, { kind: 'self' }),
      listScopedAutomations(RUNTIME, { kind: 'orphan' })
    ])
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)
  })

  it('never re-asks about a capability the incarnation already confirmed', async () => {
    const { listScopedAutomations, updateAutomationForOwner } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({
      automations: [],
      items: [],
      orphanCount: 0,
      automation: { id: 'a1' }
    })
    await listScopedAutomations(RUNTIME, { kind: 'self' })
    await listScopedAutomations(RUNTIME, { kind: 'orphan' })
    // A different capability confirmed by the same status answer is also cached.
    await updateAutomationForOwner(SSH_OWNER, 'a1', { enabled: false })
    // Mutations intentionally re-probe: owner fencing must not trust a positive
    // answer after an in-place runtime replacement under the same pairing.
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(2)
  })

  it('re-asks after a re-pair rather than trusting the old incarnation', async () => {
    const { listScopedAutomations } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
    await listScopedAutomations(RUNTIME, { kind: 'self' })
    await listScopedAutomations({ ...RUNTIME, pairingRevision: 5 }, { kind: 'self' })
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(2)
  })

  it('does not cache an absence, so an upgraded server recovers without a re-pair', async () => {
    const { listScopedAutomations, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValueOnce({ capabilities: [] })
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).resolves.toBeTruthy()
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(2)
  })

  // The fence depends on this: a server downgraded in place ignores
  // `expectedOwner`, so a confirmation must not outlive its observation window.
  it('re-asks once a confirmation ages out', async () => {
    vi.useFakeTimers()
    try {
      const { listScopedAutomations, AUTHORITY_CAPABILITY_CONFIRMATION_TTL_MS } = await client()
      getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
      callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
      await listScopedAutomations(RUNTIME, { kind: 'self' })
      vi.advanceTimersByTime(AUTHORITY_CAPABILITY_CONFIRMATION_TTL_MS)
      await listScopedAutomations(RUNTIME, { kind: 'self' })
      expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not cache a failed probe, so the next call retries the host', async () => {
    const { listScopedAutomations } = await client()
    getRuntimeEnvironmentStatus.mockRejectedValueOnce(new Error('runtime_unavailable'))
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).rejects.toThrow(
      'runtime_unavailable'
    )
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).resolves.toBeTruthy()
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(2)
  })

  it('bounds confirmed capability entries across retired environment incarnations', async () => {
    const { listScopedAutomations } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })

    for (let index = 0; index < 32; index += 1) {
      await listScopedAutomations(
        { kind: 'runtime', environmentId: `env-${index}`, pairingRevision: 1 },
        { kind: 'self' }
      )
    }
    await listScopedAutomations(
      { kind: 'runtime', environmentId: 'env-overflow', pairingRevision: 1 },
      { kind: 'self' }
    )
    await listScopedAutomations(
      { kind: 'runtime', environmentId: 'env-0', pairingRevision: 1 },
      { kind: 'self' }
    )

    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledTimes(34)
  })
})

describe('owner-fenced mutations', () => {
  it('sends the captured owner with the mutation', async () => {
    const { updateAutomationForOwner } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await updateAutomationForOwner(SSH_OWNER, 'a1', { enabled: false })
    expect(callRuntimeRpc.mock.calls[0]?.[2]).toEqual({
      id: 'a1',
      updates: { enabled: false },
      expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } },
      destination: undefined
    })
  })

  it('sends the captured destination with a selector-moving mutation', async () => {
    const { updateAutomationForOwner } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await updateAutomationForOwner(
      { authority: DESKTOP, selector: { kind: 'self' } },
      'a1',
      { projectId: 'repo-ssh' },
      { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
    )
    expect(callRuntimeRpc.mock.calls[0]?.[2]).toEqual({
      id: 'a1',
      updates: { repo: 'id:repo-ssh' },
      expectedOwner: { selector: { kind: 'self' } },
      destination: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
    })
  })

  it('stays view-only against a host without owner fencing', async () => {
    const { updateAutomationForOwner, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({
      capabilities: [AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY]
    })
    await expect(
      updateAutomationForOwner(SSH_OWNER, 'a1', { enabled: false })
    ).rejects.toBeInstanceOf(AutomationHostScopeUnsupportedError)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('fences a desktop mutation over the local runtime target with the same precondition', async () => {
    const { deleteAutomationForOwner, updateAutomationForOwner } = await client()
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await updateAutomationForOwner({ authority: DESKTOP, selector: { kind: 'self' } }, 'a1', {
      enabled: true
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'automation.update',
      expect.objectContaining({ expectedOwner: { selector: { kind: 'self' } } }),
      expect.anything()
    )
    expect(getRuntimeEnvironmentStatus).not.toHaveBeenCalled()
    expect(typeof deleteAutomationForOwner).toBe('function')
  })
})

// The orphan arm used to live in the caller with its own transport choice and no
// capability probe. These pin it to the owned arm's behaviour so the two cannot
// drift apart again.
describe('orphan-fenced mutations', () => {
  it('fences on the orphan precondition over the same runtime transport', async () => {
    const { deleteOrphanAutomation } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue(undefined)
    await deleteOrphanAutomation(RUNTIME, 'a1')
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.delete',
      { id: 'a1', expectedOwner: { selector: { kind: 'orphan' } } },
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
  })

  it('probes the host before an orphan mutation, exactly as an owned row does', async () => {
    const { updateOrphanAutomation, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({
      capabilities: [AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY]
    })
    await expect(updateOrphanAutomation(RUNTIME, 'a1', { enabled: false })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // An unreachable host is a retry, not an upgrade prompt — the orphan arm inherits this.
  it('propagates an unreachable authority instead of calling it incompatible', async () => {
    const { deleteOrphanAutomation, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockRejectedValue(new Error('runtime_unavailable'))
    await expect(deleteOrphanAutomation(RUNTIME, 'a1')).rejects.not.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })

  it('routes a desktop orphan over the local runtime target, unprobed', async () => {
    const { deleteOrphanAutomation, updateOrphanAutomation } = await client()
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await updateOrphanAutomation(DESKTOP, 'a1', { enabled: false })
    await deleteOrphanAutomation(DESKTOP, 'a1')
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'automation.update',
      {
        id: 'a1',
        updates: { enabled: false },
        expectedOwner: { selector: { kind: 'orphan' } },
        // An orphan has no host to be moved to, so no destination is ever sent.
        destination: undefined
      },
      expect.anything()
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'automation.delete',
      { id: 'a1', expectedOwner: { selector: { kind: 'orphan' } } },
      expect.anything()
    )
    expect(getRuntimeEnvironmentStatus).not.toHaveBeenCalled()
  })

  // History is the one action an orphan keeps (ORPHAN_ACTIONS), so it must reach
  // the transport rather than resolving as "no host to run on".
  it('reads an orphan run history over the runtime transport', async () => {
    const { listOrphanAutomationRuns } = await client()
    callRuntimeRpc.mockResolvedValue({ runs: [{ id: 'r1' }] })
    const runs = await listOrphanAutomationRuns(RUNTIME, 'a1')
    expect(runs).toEqual([{ id: 'r1' }])
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.runs',
      { automationId: 'a1', expectedOwner: { selector: { kind: 'orphan' } } },
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
  })

  it('reads a desktop orphan history over the local runtime target', async () => {
    const { listOrphanAutomationRuns } = await client()
    callRuntimeRpc.mockResolvedValue({ runs: [] })
    await listOrphanAutomationRuns(DESKTOP, 'a1')
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'automation.runs',
      { automationId: 'a1', expectedOwner: { selector: { kind: 'orphan' } } },
      expect.anything()
    )
  })

  // Read-only, so it deliberately takes the owned read's probe behaviour — which
  // today is no probe. Pinned so the two arms cannot diverge silently.
  it('probes on the orphan history read exactly as often as the owned read does', async () => {
    const { listAutomationRunsForOwner, listOrphanAutomationRuns } = await client()
    callRuntimeRpc.mockResolvedValue({ runs: [] })
    await listAutomationRunsForOwner(SSH_OWNER, 'a1')
    const ownedProbes = getRuntimeEnvironmentStatus.mock.calls.length
    getRuntimeEnvironmentStatus.mockClear()
    await listOrphanAutomationRuns(RUNTIME, 'a1')
    expect(getRuntimeEnvironmentStatus.mock.calls.length).toBe(ownedProbes)
  })

  it('cannot be handed an owner precondition — the fence is not a parameter', async () => {
    const { updateOrphanAutomation, ORPHAN_OWNER_PRECONDITION } = await client()
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await updateOrphanAutomation(DESKTOP, 'a1', { enabled: false })
    expect(callRuntimeRpc.mock.calls[0]?.[2]?.expectedOwner).toEqual(ORPHAN_OWNER_PRECONDITION)
    expect(updateOrphanAutomation.length).toBe(3)
  })
})

describe('matchAutomationOwnerConflict', () => {
  it('classifies a conflict rewrapped by Electron IPC', async () => {
    const { matchAutomationOwnerConflict } = await client()
    const wrapped = new Error(
      `Error invoking remote method 'automations:update': Error: This automation's host changed. Reload it before continuing.: ${AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged}`
    )
    expect(matchAutomationOwnerConflict(wrapped)).toBe(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
  })

  it('classifies a structured error code and ignores unrelated failures', async () => {
    const { matchAutomationOwnerConflict } = await client()
    expect(
      matchAutomationOwnerConflict({ code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved })
    ).toBe(AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved)
    expect(matchAutomationOwnerConflict(new Error('timeout'))).toBeNull()
  })
})
