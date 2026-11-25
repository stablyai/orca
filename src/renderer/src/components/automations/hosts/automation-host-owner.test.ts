import { describe, expect, it, vi } from 'vitest'

const revisions = new Map<string, number>()
const pending = new Map<string, number>()
const continued = new Map<string, number>()
let pairedWebEnvironment: string | null = null

vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: (id: string) => revisions.get(id),
  isRuntimeEnvironmentContinuationPending: (id: string, revision: number) =>
    pending.get(id) === revision,
  resolveContinuedRuntimeEnvironmentRevision: (id: string, revision: number) =>
    continued.get(`${id}:${revision}`) ?? revision
}))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => pairedWebEnvironment
}))

const { automationOwnerForHostId, evaluateAutomationOwner } =
  await import('./automation-host-owner')

const environments = [{ id: 'env-1', createdAt: 1, pairingRevision: 4 }]

describe('automationOwnerForHostId', () => {
  it('names this computer, or a paired runtime pinned to its pairing now', () => {
    expect(automationOwnerForHostId('local', { runtimeEnvironments: environments })).toEqual({
      authority: { kind: 'desktop' },
      selector: { kind: 'self' }
    })
    expect(
      automationOwnerForHostId('runtime:env-1', { runtimeEnvironments: environments })
    ).toEqual({
      authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 4 },
      selector: { kind: 'self' }
    })
  })

  it('maps this computer to the paired server on paired web', () => {
    pairedWebEnvironment = 'env-1'
    expect(
      automationOwnerForHostId('local', { runtimeEnvironments: environments })?.authority
    ).toEqual({ kind: 'runtime', environmentId: 'env-1', pairingRevision: 4 })
    pairedWebEnvironment = null
  })

  it('has no owner for a host this app can’t route to', () => {
    expect(automationOwnerForHostId('ssh:box', { runtimeEnvironments: environments })).toBeNull()
  })
})

describe('evaluateAutomationOwner', () => {
  const owner = {
    authority: { kind: 'runtime' as const, environmentId: 'env-1', pairingRevision: 4 },
    selector: { kind: 'self' as const }
  }

  it('tells same, continued, checking, retired and unpaired apart', () => {
    revisions.set('env-1', 4)
    expect(evaluateAutomationOwner(owner).status).toBe('same')
    revisions.set('env-1', 5)
    continued.set('env-1:4', 5)
    expect(evaluateAutomationOwner(owner)).toEqual({
      status: 'continued',
      owner: { ...owner, authority: { ...owner.authority, pairingRevision: 5 } }
    })
    continued.clear()
    pending.set('env-1', 4)
    expect(evaluateAutomationOwner(owner).status).toBe('checking')
    pending.clear()
    expect(evaluateAutomationOwner(owner).status).toBe('retired')
    revisions.delete('env-1')
    expect(evaluateAutomationOwner(owner).status).toBe('unpaired')
  })
})
