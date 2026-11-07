import { describe, expect, it } from 'vitest'
import { normalizeSshPendingPtyKill } from './ssh-pending-pty-kill'

// Epoch-scoped pty2: IDs fence one process even when incarnation was never learned.
describe('normalizeSshPendingPtyKill', () => {
  const unfenced = { requestedAt: 1_800_000_000_000, attempts: 0 }

  it('keeps an unfenced order for an epoch-scoped relay id and drops it for a legacy one', () => {
    expect(normalizeSshPendingPtyKill(unfenced, 'pty2:epoch-a:3')).toEqual(unfenced)
    expect(normalizeSshPendingPtyKill(unfenced, 'pty-3')).toBeNull()
  })

  it('keeps a fenced order and drops a malformed one', () => {
    const fenced = { ...unfenced, incarnationId: 'inc-a' }
    expect(normalizeSshPendingPtyKill(fenced, 'pty-3')).toEqual(fenced)
    expect(normalizeSshPendingPtyKill({ attempts: 0 }, 'pty2:epoch-a:3')).toBeNull()
  })
})
