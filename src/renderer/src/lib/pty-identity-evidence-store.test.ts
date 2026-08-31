import { describe, expect, it } from 'vitest'
import { createPtyIdentityEvidenceStore } from './pty-identity-evidence-store'

const evidence = (overrides: Record<string, unknown> = {}) => ({
  verdict: 'live' as const,
  processName: 'codex',
  authorityGeneration: 'g1',
  observationEpoch: 1,
  capturedAgeMs: 0,
  ...overrides
})

describe('PTY identity evidence store', () => {
  it('rejects non-increasing pushes and rebases serialized age', () => {
    let clock = 100
    const store = createPtyIdentityEvidenceStore({ now: () => clock })
    const row = {
      hostId: 'ssh:box',
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      authorityGeneration: 'g1',
      observationEpoch: 1,
      evidence: evidence({ capturedAgeMs: 4_000 })
    }
    expect(store.applyPush(row)).toBe(true)
    expect(store.applyPush(row)).toBe(false)
    expect(store.get('ssh:box', 'pty-1', 'inc-1')?.receivedAtMs).toBe(-3_900)
    clock = 6_000
    expect(store.get('ssh:box', 'pty-1', 'inc-1')?.evidence.verdict).toBe('unverifiable')
  })

  it('fences a late row from a retired authority generation', () => {
    const store = createPtyIdentityEvidenceStore({ now: () => 0 })
    const base = {
      hostId: 'ssh:box',
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      observationEpoch: 1,
      evidence: evidence()
    }
    expect(store.applyPush({ ...base, authorityGeneration: 'g1' })).toBe(true)
    expect(
      store.applyPush({
        ...base,
        authorityGeneration: 'g2',
        evidence: evidence({ authorityGeneration: 'g2' })
      })
    ).toBe(false)
    expect(
      store.applyPush({
        ...base,
        authorityGeneration: 'g1',
        observationEpoch: 2,
        evidence: evidence({ observationEpoch: 2 })
      })
    ).toBe(true)
    store.activateGeneration('ssh:box', 'g2')
    expect(
      store.applyPush({
        ...base,
        authorityGeneration: 'g2',
        evidence: evidence({ authorityGeneration: 'g2' })
      })
    ).toBe(true)
  })
})
